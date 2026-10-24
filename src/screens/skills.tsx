import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCheck,
  Code2,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  FolderPlus,
  Layers,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sliders,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  enabledFor,
  estimateTokens,
  inIndex,
  proposedDiff,
  skillTemplate,
} from "../kernel/skillIndex";
import type { McpServer, PluginPackage, Skill } from "../types";
import { useOmni } from "../store";
import { Pill } from "../ui/bits";
import { AppLogo } from "../ui/appLogos";
import { pickPaths } from "../api";

export function Skills() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);

  // Studio Sub-tabs: Skills | Plugins | MCP Servers | Author & Add
  const [activeTab, setActiveTab] = useState<"skills" | "plugins" | "mcp" | "author">("skills");

  // Profile / Scope Selector
  const [profileId, setProfileId] = useState<string>(snap.activeProfileId || snap.profiles[0]?.id || "");
  const [scopeFilter, setScopeFilter] = useState<"all" | "global" | "profile" | "plugin">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Viewing Skill Modal State (for full description)
  const [viewingSkill, setViewingSkill] = useState<Skill | null>(null);

  // Editing Skill State
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [editBody, setEditBody] = useState<string>("");
  const [editFiles, setEditFiles] = useState<{ path: string; content: string }[]>([]);

  // Plugins Tab State
  const [pluginSubTab, setPluginSubTab] = useState<"installed" | "project">("installed");
  const [trustPluginId, setTrustPluginId] = useState<string>("");

  // Author & Add Form State
  const [authorKind, setAuthorKind] = useState<"skill" | "mcp" | "plugin">("skill");
  const [newSkillSlug, setNewSkillSlug] = useState<string>("");
  const [newSkillTitle, setNewSkillTitle] = useState<string>("");
  const [newSkillDesc, setNewSkillDesc] = useState<string>("");
  const [newSkillTools, setNewSkillTools] = useState<string>("");
  const [newSkillBody, setNewSkillBody] = useState<string>("");
  const [authorNotice, setAuthorNotice] = useState<string>("");

  // MCP Author Form State
  const [mcpName, setMcpName] = useState<string>("");
  const [mcpTransport, setMcpTransport] = useState<string>("stdio");
  const [mcpCommand, setMcpCommand] = useState<string>("");
  const [mcpUrl, setMcpUrl] = useState<string>("");
  const [mcpTool, setMcpTool] = useState<string>("");

  // Plugin Author Form State
  const [plugSlug, setPlugSlug] = useState<string>("");
  const [plugName, setPlugName] = useState<string>("");
  const [plugTool, setPlugTool] = useState<string>("");
  const [plugHook, setPlugHook] = useState<string>("session_start");
  const [plugHasAgent, setPlugHasAgent] = useState<boolean>(true);
  const [plugHasDesktop, setPlugHasDesktop] = useState<boolean>(false);
  const [plugLabel, setPlugLabel] = useState<string>("");

  const profile = snap.profiles.find((p) => p.id === profileId) ?? snap.profiles[0];
  const proposals = snap.skillProposals.filter((p) => p.profileId === profile?.id && p.status === "pending");

  // Filtered Skills
  const filteredSkills = useMemo(() => {
    return snap.skills.filter((skill) => {
      // Scope match
      if (scopeFilter === "global" && (skill.ownerProfileId && skill.ownerProfileId !== "")) return false;
      if (scopeFilter === "profile" && skill.ownerProfileId !== profile?.id) return false;
      if (scopeFilter === "plugin" && skill.origin !== "plugin") return false;

      // Search match
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      const haystack = `${skill.title} ${skill.slug} ${skill.description} ${skill.slashCommand} ${skill.requiresTools.join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [snap.skills, scopeFilter, searchQuery, profile?.id]);

  // Plugin Collections
  const installedPlugins = useMemo(() => {
    return snap.plugins.filter((p) => p.source !== "project" || p.trust === "trusted");
  }, [snap.plugins]);

  const projectPlugins = useMemo(() => {
    return snap.plugins.filter((p) => p.source === "project");
  }, [snap.plugins]);

  const pendingTrustPlugin = useMemo(() => {
    return snap.plugins.find((p) => p.id === trustPluginId);
  }, [snap.plugins, trustPluginId]);

  // Skill Save Handler
  const handleSaveSkill = async (targetSkill: Skill, nextBody: string) => {
    if (!profile) return;
    await run("save_skill", {
      draft: {
        id: targetSkill.id,
        profileId: profile.id,
        slug: targetSkill.slug,
        title: targetSkill.title,
        description: targetSkill.description,
        slashCommand: targetSkill.slashCommand,
        requiresTools: targetSkill.requiresTools,
        platforms: targetSkill.platforms,
        body: nextBody,
        files: targetSkill.files ?? [],
      },
    });
    setEditingSkill(null);
  };

  // Author SKILL.md Save Handler
  const handleCreateNewSkill = async () => {
    const slug = newSkillSlug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || `skill-${Date.now().toString().slice(-4)}`;
    const title = newSkillTitle.trim() || slug;
    const desc = newSkillDesc.trim() || `Playbook instructions for /${slug}`;
    const tools = newSkillTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const bodyContent =
      newSkillBody.trim() ||
      `---\nname: ${slug}\ndescription: ${desc}\nslash_command: /${slug}\nrequires_tools: [${tools.join(", ")}]\nplatforms: [windows, macos, linux]\n---\n\n# ${title}\n\n1. Follow prompt instructions carefully.\n`;

    await run("save_skill", {
      draft: {
        id: "",
        profileId: profile?.id || "",
        slug,
        title,
        description: desc,
        slashCommand: `/${slug}`,
        requiresTools: tools,
        platforms: ["windows", "macos", "linux"],
        body: bodyContent,
        files: [],
      },
    });

    setAuthorNotice(`✓ Successfully authored and registered /${slug}`);
    setNewSkillSlug("");
    setNewSkillTitle("");
    setNewSkillDesc("");
    setNewSkillTools("");
    setNewSkillBody("");
    setActiveTab("skills");
  };

  return (
    <div className="screen select-none space-y-5" style={{ maxWidth: 1440, margin: "0 auto", paddingBottom: 48 }}>
      {/* =====================================================================
          1. HEADER BAR & GLOBAL ACTIONS
         ===================================================================== */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-[#0F172A]">Skills & Capabilities</h1>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 rounded-full">
              {snap.skills.length} skills
            </span>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 rounded-full">
              {snap.plugins.length} plugins
            </span>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 rounded-full">
              {snap.mcpServers.length} MCP servers
            </span>
          </div>
          <p className="text-xs text-[#64748B]">
            Unified agent intelligence studio: Playbook skills, MCP tool servers, and extensible plugins with scoped permissions.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            disabled={busy}
            onClick={() => void run("scan_project_plugins")}
            className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-slate-400 transition flex items-center gap-1.5"
          >
            <RefreshCw size={13} /> Scan project
          </button>
          <button
            onClick={() => {
              setAuthorKind("skill");
              setActiveTab("author");
            }}
            className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-slate-400 transition flex items-center gap-1.5"
          >
            <Plus size={13} /> New skill
          </button>
          <button
            onClick={() => {
              setAuthorKind("mcp");
              setActiveTab("author");
            }}
            className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-slate-400 transition flex items-center gap-1.5"
          >
            <Server size={13} /> Add MCP
          </button>
          <button
            onClick={() => {
              setAuthorKind("plugin");
              setActiveTab("author");
            }}
            className="px-3.5 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition flex items-center gap-1.5 shadow-xs"
            style={{ color: "#ffffff" }}
          >
            <Puzzle size={13} className="text-white" stroke="#ffffff" />
            <span className="text-white" style={{ color: "#ffffff" }}>New plugin</span>
          </button>
        </div>
      </div>

      {/* =====================================================================
          2. SCOPE SELECTOR & MAIN NAVIGATION TABS
         ===================================================================== */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-2.5 border border-[#E5E5E5] rounded-[10px] shadow-2xs">
        {/* Navigation Sub-tabs */}
        <div className="flex items-center gap-1 bg-[#F1F5F9] p-1 rounded-[8px] border border-[#E2E8F0]">
          <button
            type="button"
            onClick={() => setActiveTab("skills")}
            className={`px-3.5 py-1.5 text-xs rounded-[6px] transition flex items-center gap-1.5 ${
              activeTab === "skills"
                ? "bg-white text-slate-800 shadow-xs border border-slate-300/80 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium"
            }`}
          >
            <Sparkles size={13} /> Playbook Skills ({snap.skills.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("plugins")}
            className={`px-3.5 py-1.5 text-xs rounded-[6px] transition flex items-center gap-1.5 ${
              activeTab === "plugins"
                ? "bg-white text-slate-800 shadow-xs border border-slate-300/80 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium"
            }`}
          >
            <Puzzle size={13} /> Plugins ({snap.plugins.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mcp")}
            className={`px-3.5 py-1.5 text-xs rounded-[6px] transition flex items-center gap-1.5 ${
              activeTab === "mcp"
                ? "bg-white text-slate-800 shadow-xs border border-slate-300/80 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium"
            }`}
          >
            <Server size={13} /> MCP Servers ({snap.mcpServers.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("author")}
            className={`px-3.5 py-1.5 text-xs rounded-[6px] transition flex items-center gap-1.5 ${
              activeTab === "author"
                ? "bg-white text-slate-800 shadow-xs border border-slate-300/80 font-bold"
                : "text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium"
            }`}
          >
            <Plus size={13} /> Author & Add
          </button>
        </div>

        {/* Profile Scope Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[#64748B]">Active Scope:</span>
          <select
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-medium"
          >
            {snap.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.handle} ({p.role || "Bot"})
              </option>
            ))}
          </select>
        </div>
      </div>

      {authorNotice && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-[8px] flex items-center justify-between">
          <span>{authorNotice}</span>
          <button onClick={() => setAuthorNotice("")} className="text-emerald-700 hover:text-emerald-900">
            <X size={14} />
          </button>
        </div>
      )}

      {/* =====================================================================
          TAB 1: PLAYBOOK SKILLS
         ===================================================================== */}
      {activeTab === "skills" && (
        <div className="space-y-4">
          {/* Pending Proposals Section if any */}
          {proposals.length > 0 && (
            <div className="bg-amber-50/60 border border-amber-200 rounded-[10px] p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                <AlertCircle size={15} className="text-amber-600" />
                <span>Pending Agent Proposals ({proposals.length})</span>
              </div>
              <p className="text-xs text-amber-800">
                The agent proposed updating a SKILL.md playbook. Review the diff before confirming write.
              </p>
              {proposals.map((proposal) => (
                <div key={proposal.id} className="bg-white border border-amber-200 rounded-[8px] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">/{proposal.slug}</span>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={busy}
                        onClick={() => void run("resolve_skill_proposal", { id: proposal.id, approve: true })}
                        className="px-2.5 py-1 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-[4px] transition"
                      >
                        Approve Write
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void run("resolve_skill_proposal", { id: proposal.id, approve: false })}
                        className="px-2.5 py-1 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-[4px] transition"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                  <pre className="p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-x-auto max-h-48 whitespace-pre-wrap">
                    {proposedDiff(proposal.currentBody, proposal.proposedBody)}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {/* Filter & Search Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { id: "all", label: "All Skills" },
                { id: "global", label: "Global (Every Bot)" },
                { id: "profile", label: `This Profile (${profile?.handle})` },
                { id: "plugin", label: "Plugin Bundled" },
              ].map((filterItem) => (
                <button
                  key={filterItem.id}
                  onClick={() => setScopeFilter(filterItem.id as any)}
                  className={`px-3 py-1.5 text-xs rounded-[6px] transition font-medium ${
                    scopeFilter === filterItem.id
                      ? "bg-slate-700 text-white shadow-2xs"
                      : "bg-white border border-[#E5E5E5] text-slate-600 hover:border-slate-300"
                  }`}
                  style={scopeFilter === filterItem.id ? { color: "#ffffff" } : undefined}
                >
                  <span style={scopeFilter === filterItem.id ? { color: "#ffffff" } : undefined}>
                    {filterItem.label}
                  </span>
                </button>
              ))}
            </div>

            <div className="relative min-w-[260px]">
              <Search size={13} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search skills, commands, tools..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 shadow-2xs"
              />
            </div>
          </div>

          {/* Skills Cards Grid with Truncated 2-3 Line Description and View Full Description Button */}
          {filteredSkills.length === 0 ? (
            <div className="bg-white border border-[#E5E5E5] rounded-[10px] p-8 text-center space-y-2">
              <Sparkles size={24} className="mx-auto text-slate-400" />
              <p className="text-xs font-semibold text-slate-700">No matching skills found.</p>
              <p className="text-xs text-slate-500">Author a new SKILL.md or adjust your search filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {filteredSkills.map((skill) => {
                const isOn = enabledFor(skill.enables, profile?.id ?? "");
                return (
                  <div
                    key={skill.id}
                    className="bg-white border border-[#E5E5E5] hover:border-slate-300 rounded-[10px] p-4 flex flex-col justify-between gap-3 shadow-2xs transition"
                  >
                    <div className="space-y-2">
                      {/* Card Header: Slash Command + Origin + Toggle */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <AppLogo id={skill.id} name={skill.title || skill.slug} size={22} />
                          <span className="text-xs font-bold text-slate-900 truncate">
                            {skill.slashCommand || `/${skill.slug}`}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-100 text-slate-600 border border-slate-200 rounded shrink-0">
                            {skill.origin}
                          </span>
                        </div>

                        {/* Profile Active Switch */}
                        <button
                          type="button"
                          onClick={() =>
                            void run("toggle_skill", {
                              id: skill.id,
                              profileId: profile?.id ?? "",
                              enabled: !isOn,
                            })
                          }
                          className={`px-2 py-0.5 text-[11px] font-semibold rounded-[4px] transition border ${
                            isOn
                              ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                              : "bg-slate-100 text-slate-500 border-slate-200 hover:text-slate-800"
                          }`}
                        >
                          {isOn ? "Active" : "Disabled"}
                        </button>
                      </div>

                      {/* Truncated 2-3 Line Description */}
                      <p
                        className="text-xs text-[#64748B] leading-relaxed"
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                        title={skill.description}
                      >
                        {skill.description || "No description provided."}
                      </p>

                      {/* Required Tools Pills */}
                      {skill.requiresTools.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {skill.requiresTools.slice(0, 4).map((tool) => (
                            <span
                              key={tool}
                              className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-50 text-slate-600 border border-slate-200 rounded"
                            >
                              {tool}
                            </span>
                          ))}
                          {skill.requiresTools.length > 4 && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-50 text-slate-400 border border-slate-200 rounded">
                              +{skill.requiresTools.length - 4}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Bottom Action Row: View full description button */}
                    <div className="flex items-center justify-between pt-2 border-t border-[#F1F5F9]">
                      <button
                        type="button"
                        onClick={() => setViewingSkill(skill)}
                        className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-[5px] transition flex items-center gap-1.5 shadow-2xs"
                      >
                        <Eye size={12} /> View full description
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setEditingSkill(skill);
                          setEditBody(skill.body);
                          setEditFiles(skill.files ?? []);
                        }}
                        className="p-1 text-slate-400 hover:text-slate-700 rounded transition"
                        title="Edit playbook"
                      >
                        <Edit3 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB 2: PLUGINS & PACKAGES
         ===================================================================== */}
      {activeTab === "plugins" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-white p-2.5 border border-[#E5E5E5] rounded-[8px]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPluginSubTab("installed")}
                className={`px-3 py-1 text-xs font-semibold rounded-[5px] transition ${
                  pluginSubTab === "installed"
                    ? "bg-slate-700 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
                style={pluginSubTab === "installed" ? { color: "#ffffff" } : undefined}
              >
                <span style={pluginSubTab === "installed" ? { color: "#ffffff" } : undefined}>
                  Installed Plugins ({installedPlugins.length})
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPluginSubTab("project")}
                className={`px-3 py-1 text-xs font-semibold rounded-[5px] transition ${
                  pluginSubTab === "project"
                    ? "bg-slate-700 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
                style={pluginSubTab === "project" ? { color: "#ffffff" } : undefined}
              >
                <span style={pluginSubTab === "project" ? { color: "#ffffff" } : undefined}>
                  Project Local ({projectPlugins.length})
                </span>
              </button>
            </div>
            <span className="text-xs text-slate-500">
              Folder: <code>.omniworkspace/plugins</code>
            </span>
          </div>

          <div className="bg-white border border-[#E5E5E5] rounded-[10px] overflow-hidden shadow-2xs">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#F8FAFC] border-b border-[#E5E5E5] text-[#64748B] font-semibold">
                  <th className="py-2.5 px-4">Package</th>
                  <th className="py-2.5 px-4">Declared Capabilities</th>
                  <th className="py-2.5 px-4">Agent ({profile?.handle})</th>
                  <th className="py-2.5 px-4">Desktop</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1F5F9]">
                {(pluginSubTab === "project" ? projectPlugins : installedPlugins).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No plugins found in this category. Click "New plugin" to create one.
                    </td>
                  </tr>
                ) : (
                  (pluginSubTab === "project" ? projectPlugins : installedPlugins).map((plugin) => {
                    const agentOn = enabledFor(plugin.agentEnables, profile?.id ?? "");
                    return (
                      <tr key={plugin.id} className="hover:bg-slate-50/60 transition">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <AppLogo id={plugin.id} name={plugin.name} size={28} />
                            <div>
                              <div className="font-bold text-slate-900">{plugin.name}</div>
                              <div className="text-[11px] text-[#64748B] font-mono">
                                v{plugin.version} • {plugin.source} •{" "}
                                <span
                                  className={`font-semibold ${
                                    plugin.trust === "trusted" ? "text-emerald-700" : "text-amber-700"
                                  }`}
                                >
                                  {plugin.trust}
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {plugin.tools.map((t) => (
                              <span
                                key={t.name}
                                className="px-1.5 py-0.5 bg-slate-100 text-slate-700 border border-slate-200 rounded text-[10px] font-mono"
                              >
                                {t.name}
                              </span>
                            ))}
                            {plugin.bundledSkills.map((s) => (
                              <span
                                key={s}
                                className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded text-[10px] font-mono"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          {plugin.hasAgent ? (
                            <button
                              disabled={busy || !profile?.id}
                              onClick={() =>
                                void run("toggle_plugin_agent", {
                                  id: plugin.id,
                                  profileId: profile?.id,
                                  enabled: !agentOn,
                                })
                              }
                              className={`px-2 py-0.5 text-[11px] font-semibold rounded border transition ${
                                agentOn
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                                  : "bg-slate-100 text-slate-600 border-slate-200"
                              }`}
                            >
                              {agentOn ? "Active" : "Off"}
                            </button>
                          ) : (
                            <span className="text-slate-400 text-[11px]">No agent part</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {plugin.hasDesktop ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void run("toggle_plugin_desktop", {
                                  id: plugin.id,
                                  enabled: !plugin.desktopEnabled,
                                })
                              }
                              className={`px-2 py-0.5 text-[11px] font-semibold rounded border transition ${
                                plugin.desktopEnabled
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                                  : "bg-slate-100 text-slate-600 border-slate-200"
                              }`}
                            >
                              {plugin.desktopEnabled ? "Active" : "Off"}
                            </button>
                          ) : (
                            <span className="text-slate-400 text-[11px]">No desktop part</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {plugin.trust !== "trusted" && (
                              <button
                                onClick={() => setTrustPluginId(plugin.id)}
                                className="px-2 py-1 text-xs font-semibold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded transition"
                              >
                                Trust
                              </button>
                            )}
                            {plugin.source !== "builtin" && (
                              <button
                                onClick={() => void run("remove_plugin", { id: plugin.id })}
                                className="p-1 text-slate-400 hover:text-rose-600 rounded transition"
                                title="Remove plugin"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 3: MCP SERVERS
         ===================================================================== */}
      {activeTab === "mcp" && (
        <div className="space-y-4">
          <div className="bg-white border border-[#E5E5E5] rounded-[10px] overflow-hidden shadow-2xs">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#F8FAFC] border-b border-[#E5E5E5] text-[#64748B] font-semibold">
                  <th className="py-2.5 px-4">MCP Server</th>
                  <th className="py-2.5 px-4">Transport</th>
                  <th className="py-2.5 px-4">Command or URL</th>
                  <th className="py-2.5 px-4">Profile Switch</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1F5F9]">
                {snap.mcpServers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No Model Context Protocol (MCP) servers registered yet.
                    </td>
                  </tr>
                ) : (
                  snap.mcpServers.map((server) => {
                    const on = enabledFor(server.enables, profile?.id ?? "");
                    return (
                      <tr key={server.id} className="hover:bg-slate-50/60 transition">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <AppLogo id={server.id} name={server.name} url={server.url} command={server.command} size={28} />
                            <div>
                              <div className="font-bold text-slate-900">{server.name}</div>
                              <div className="text-[11px] text-[#64748B] font-mono">{server.trust}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono">{server.transport}</td>
                        <td className="py-3 px-4 font-mono text-[#475569]">
                          {server.transport === "sse" ? server.url || "—" : server.command || "—"}
                        </td>
                        <td className="py-3 px-4">
                          <button
                            disabled={busy || !profile?.id}
                            onClick={() =>
                              void run("toggle_mcp", {
                                id: server.id,
                                profileId: profile?.id,
                                enabled: !on,
                              })
                            }
                            className={`px-2 py-0.5 text-[11px] font-semibold rounded border transition ${
                              on
                                ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                                : "bg-slate-100 text-slate-600 border-slate-200"
                            }`}
                          >
                            {on ? "Active" : "Off"}
                          </button>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {server.trust !== "trusted" && (
                              <button
                                onClick={() => void run("trust_mcp", { id: server.id })}
                                className="px-2 py-1 text-xs font-semibold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded transition"
                              >
                                Trust
                              </button>
                            )}
                            <button
                              onClick={() => void run("remove_mcp", { id: server.id })}
                              className="p-1 text-slate-400 hover:text-rose-600 rounded transition"
                              title="Remove MCP server"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 4: AUTHOR & ADD
         ===================================================================== */}
      {activeTab === "author" && (
        <div className="bg-white border border-[#E5E5E5] rounded-[10px] p-5 space-y-4 shadow-sm">
          {/* Sub-selector */}
          <div className="flex items-center gap-1.5 bg-[#F1F5F9] p-1 rounded-[8px] border border-[#E2E8F0] w-fit">
            <button
              type="button"
              onClick={() => setAuthorKind("skill")}
              className={`px-3 py-1.5 text-xs rounded-[6px] transition font-semibold ${
                authorKind === "skill" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              ⚡ New SKILL.md Playbook
            </button>
            <button
              type="button"
              onClick={() => setAuthorKind("mcp")}
              className={`px-3 py-1.5 text-xs rounded-[6px] transition font-semibold ${
                authorKind === "mcp" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              🔌 Add MCP Server
            </button>
            <button
              type="button"
              onClick={() => setAuthorKind("plugin")}
              className={`px-3 py-1.5 text-xs rounded-[6px] transition font-semibold ${
                authorKind === "plugin" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              🧩 New Plugin Manifest
            </button>
          </div>

          {authorKind === "skill" && (
            <div className="space-y-3.5 max-w-3xl">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Skill Slug (Command)</label>
                  <input
                    type="text"
                    value={newSkillSlug}
                    onChange={(e) => setNewSkillSlug(e.target.value)}
                    placeholder="e.g. quant-trader or audit-code"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Display Title</label>
                  <input
                    type="text"
                    value={newSkillTitle}
                    onChange={(e) => setNewSkillTitle(e.target.value)}
                    placeholder="e.g. Quantitative Execution Policy"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Short Description</label>
                  <input
                    type="text"
                    value={newSkillDesc}
                    onChange={(e) => setNewSkillDesc(e.target.value)}
                    placeholder="2-3 sentence overview of this playbook..."
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Required Tools (comma separated)</label>
                  <input
                    type="text"
                    value={newSkillTools}
                    onChange={(e) => setNewSkillTools(e.target.value)}
                    placeholder="e.g. bash, git, python"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-700">Playbook Instructions (Markdown)</label>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const picked = await pickPaths("files");
                        if (picked && picked[0]) {
                          setNewSkillSlug(picked[0].split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "");
                        }
                      } catch {}
                    }}
                    className="text-[11px] font-medium text-slate-500 hover:text-slate-800 underline flex items-center gap-1"
                  >
                    <FileText size={11} /> Pick local SKILL.md file
                  </button>
                </div>
                <textarea
                  value={newSkillBody}
                  onChange={(e) => setNewSkillBody(e.target.value)}
                  rows={8}
                  placeholder={`# Playbook Instructions\n\n1. Check active market parameters.\n2. Execute orders with slippage safeguards.`}
                  className="w-full p-3 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                />
              </div>

              <button
                type="button"
                onClick={handleCreateNewSkill}
                className="px-4 py-2 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition flex items-center gap-1.5 shadow-2xs"
                style={{ color: "#ffffff" }}
              >
                <Check size={13} className="text-white" stroke="#ffffff" />
                <span className="text-white" style={{ color: "#ffffff" }}>Save & Register Skill</span>
              </button>
            </div>
          )}

          {authorKind === "mcp" && (
            <div className="space-y-3.5 max-w-2xl">
              {/* Live Logo / Connector Preview */}
              <div className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-[8px] flex items-center gap-3">
                <AppLogo
                  id={mcpName}
                  name={mcpName}
                  url={mcpTransport === "sse" ? mcpUrl : ""}
                  command={mcpTransport === "stdio" ? mcpCommand : ""}
                  size={36}
                />
                <div className="text-xs">
                  <div className="font-semibold text-slate-900">
                    {mcpName.trim() ? mcpName : "Connector Preview"}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {mcpTransport === "sse" && mcpUrl.trim()
                      ? `Resolves logo or favicon dynamically from ${mcpUrl}`
                      : "Official brand logo, CLI tool icon, or favicon"}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Server Name</label>
                  <input
                    type="text"
                    value={mcpName}
                    onChange={(e) => setMcpName(e.target.value)}
                    placeholder="e.g. postgres-mcp"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Transport</label>
                  <select
                    value={mcpTransport}
                    onChange={(e) => setMcpTransport(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                  >
                    <option value="stdio">stdio (Local Subprocess)</option>
                    <option value="sse">sse (HTTP Server Sent Events)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700">
                  {mcpTransport === "sse" ? "Server URL" : "Execution Command"}
                </label>
                <input
                  type="text"
                  value={mcpTransport === "sse" ? mcpUrl : mcpCommand}
                  onChange={(e) => (mcpTransport === "sse" ? setMcpUrl(e.target.value) : setMcpCommand(e.target.value))}
                  placeholder={mcpTransport === "sse" ? "http://127.0.0.1:3000/sse" : "npx -y @modelcontextprotocol/server-postgres"}
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-700">Declared Tool Name</label>
                <input
                  type="text"
                  value={mcpTool}
                  onChange={(e) => setMcpTool(e.target.value)}
                  placeholder="e.g. query_db"
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                />
              </div>

              <button
                type="button"
                disabled={busy || !mcpName.trim()}
                onClick={async () => {
                  await run("save_mcp", {
                    draft: {
                      id: "",
                      name: mcpName.trim(),
                      transport: mcpTransport,
                      command: mcpCommand.trim(),
                      args: [],
                      url: mcpUrl.trim(),
                      tools: mcpTool.trim() ? [{ name: mcpTool.trim(), description: mcpTool.trim() }] : [],
                    },
                  });
                  setAuthorNotice(`✓ Registered MCP server "${mcpName}"`);
                  setMcpName("");
                  setMcpCommand("");
                  setMcpUrl("");
                  setMcpTool("");
                  setActiveTab("mcp");
                }}
                className="px-4 py-2 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition flex items-center gap-1.5 shadow-2xs"
                style={{ color: "#ffffff" }}
              >
                <Check size={13} className="text-white" stroke="#ffffff" />
                <span className="text-white" style={{ color: "#ffffff" }}>Save MCP Server</span>
              </button>
            </div>
          )}

          {authorKind === "plugin" && (
            <div className="space-y-3.5 max-w-2xl">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Folder Slug</label>
                  <input
                    type="text"
                    value={plugSlug}
                    onChange={(e) => setPlugSlug(e.target.value)}
                    placeholder="my-plugin"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Display Name</label>
                  <input
                    type="text"
                    value={plugName}
                    onChange={(e) => setPlugName(e.target.value)}
                    placeholder="My Custom Extension"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPlugHasAgent((v) => !v)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-[5px] border transition ${
                    plugHasAgent ? "bg-slate-700 text-white border-slate-700" : "bg-white text-slate-600 border-[#E5E5E5]"
                  }`}
                  style={plugHasAgent ? { color: "#ffffff" } : undefined}
                >
                  <span style={plugHasAgent ? { color: "#ffffff" } : undefined}>Agent Capability</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPlugHasDesktop((v) => !v)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-[5px] border transition ${
                    plugHasDesktop ? "bg-slate-700 text-white border-slate-700" : "bg-white text-slate-600 border-[#E5E5E5]"
                  }`}
                  style={plugHasDesktop ? { color: "#ffffff" } : undefined}
                >
                  <span style={plugHasDesktop ? { color: "#ffffff" } : undefined}>Desktop Slot</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Declared Tool</label>
                  <input
                    type="text"
                    value={plugTool}
                    onChange={(e) => setPlugTool(e.target.value)}
                    placeholder="e.g. format_report"
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Execution Hook</label>
                  <select
                    value={plugHook}
                    onChange={(e) => setPlugHook(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                  >
                    {["session_start", "before_model_call", "before_tool_call", "after_tool_call", "session_end"].map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                type="button"
                disabled={busy || !plugSlug.trim()}
                onClick={async () => {
                  await run("save_plugin", {
                    draft: {
                      id: "",
                      version: "1.0.0",
                      slug: plugSlug.trim(),
                      name: plugName.trim() || plugSlug.trim(),
                      hasAgent: plugHasAgent,
                      hasDesktop: plugHasDesktop,
                      tools: plugTool.trim() ? [{ name: plugTool.trim(), description: plugTool.trim() }] : [],
                      hooks: plugHasAgent ? [plugHook] : [],
                      skills: [],
                      desktop: plugHasDesktop && plugLabel.trim() ? [{ kind: "status", label: plugLabel.trim(), target: "" }] : [],
                    },
                  });
                  setAuthorNotice(`✓ Created plugin manifest for "${plugSlug}"`);
                  setPlugSlug("");
                  setPlugName("");
                  setPlugTool("");
                  setActiveTab("plugins");
                }}
                className="px-4 py-2 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition flex items-center gap-1.5 shadow-2xs"
                style={{ color: "#ffffff" }}
              >
                <Check size={13} className="text-white" stroke="#ffffff" />
                <span className="text-white" style={{ color: "#ffffff" }}>Save Plugin Manifest</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          5. MODAL: VIEW FULL DESCRIPTION OF SKILL (User requested)
         ===================================================================== */}
      {viewingSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
          onClick={() => setViewingSkill(null)}
        >
          <div
            className="bg-white border border-[#E5E5E5] rounded-[12px] shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-[#E5E5E5] flex items-center justify-between bg-[#F8FAFC]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-white border border-[#E2E8F0] rounded-[8px] text-slate-700 shadow-2xs">
                  <Sparkles size={18} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-[#0F172A]">
                      {viewingSkill.slashCommand || `/${viewingSkill.slug}`}
                    </h3>
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-100 text-slate-700 border border-slate-200 rounded-full">
                      {viewingSkill.origin}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#64748B]">{viewingSkill.title || viewingSkill.slug}</p>
                </div>
              </div>
              <button
                onClick={() => setViewingSkill(null)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded hover:bg-slate-200 transition"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal Scrollable Body */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Full Description Section */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-800 block">Full Description</label>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-[8px] text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {viewingSkill.description || "No description provided."}
                </div>
              </div>

              {/* Standing Prompt Index Line */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-800">Standing Prompt Index Line</label>
                  <span className="text-[10px] font-mono text-slate-500">
                    ~{estimateTokens(viewingSkill.indexLine)} tokens
                  </span>
                </div>
                <pre className="p-2.5 bg-slate-100 border border-slate-200 rounded-[6px] text-xs font-mono text-slate-800 whitespace-pre-wrap">
                  {viewingSkill.indexLine}
                </pre>
              </div>

              {/* Playbook Instructions (body) */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-800 block">Playbook Instructions (Markdown)</label>
                <pre className="p-3 bg-slate-900 text-slate-100 rounded-[6px] text-xs font-mono overflow-y-auto max-h-56 whitespace-pre-wrap border border-slate-700">
                  {viewingSkill.body}
                </pre>
              </div>

              {/* Required Tools & Platforms */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Required Tools</label>
                  <div className="flex flex-wrap gap-1">
                    {viewingSkill.requiresTools.length > 0 ? (
                      viewingSkill.requiresTools.map((t) => (
                        <span key={t} className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-mono border border-slate-200">
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-400">None required</span>
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Platforms</label>
                  <div className="flex flex-wrap gap-1">
                    {(viewingSkill.platforms.length > 0 ? viewingSkill.platforms : ["windows", "macos", "linux"]).map((p) => (
                      <span key={p} className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-mono border border-slate-200">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Supporting Files if any */}
              {viewingSkill.files && viewingSkill.files.length > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-slate-200">
                  <label className="text-xs font-bold text-slate-800 block">Supporting Reference Files</label>
                  <div className="space-y-2">
                    {viewingSkill.files.map((f) => (
                      <div key={f.path} className="border border-slate-200 rounded p-2.5 bg-slate-50 space-y-1">
                        <span className="text-xs font-mono font-semibold text-slate-800">{f.path}</span>
                        <pre className="text-[11px] font-mono text-slate-600 max-h-32 overflow-y-auto whitespace-pre-wrap">
                          {f.content}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 border-t border-[#E5E5E5] flex items-center justify-between bg-[#F8FAFC]">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const currentOn = enabledFor(viewingSkill.enables, profile?.id ?? "");
                    void run("toggle_skill", {
                      id: viewingSkill.id,
                      profileId: profile?.id ?? "",
                      enabled: !currentOn,
                    });
                    setViewingSkill((prev) =>
                      prev
                        ? {
                            ...prev,
                            enables: [
                              ...prev.enables.filter((f) => f.profileId !== profile?.id),
                              { profileId: profile?.id ?? "", enabled: !currentOn },
                            ],
                          }
                        : null
                    );
                  }}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-[5px] border transition ${
                    enabledFor(viewingSkill.enables, profile?.id ?? "")
                      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                      : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
                  }`}
                >
                  {enabledFor(viewingSkill.enables, profile?.id ?? "") ? "Active for Profile" : "Disabled for Profile"}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingSkill(viewingSkill);
                    setEditBody(viewingSkill.body);
                    setEditFiles(viewingSkill.files ?? []);
                    setViewingSkill(null);
                  }}
                  className="px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-[6px] transition flex items-center gap-1.5"
                >
                  <Edit3 size={13} /> Edit Playbook
                </button>
                <button
                  type="button"
                  onClick={() => setViewingSkill(null)}
                  className="px-4 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition"
                  style={{ color: "#ffffff" }}
                >
                  <span className="text-white" style={{ color: "#ffffff" }}>Close</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          6. MODAL: EDIT SKILL PLAYBOOK
         ===================================================================== */}
      {editingSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
          onClick={() => setEditingSkill(null)}
        >
          <div
            className="bg-white border border-[#E5E5E5] rounded-[12px] shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[#E5E5E5] flex items-center justify-between bg-[#F8FAFC]">
              <div className="flex items-center gap-2">
                <Edit3 size={16} className="text-slate-700" />
                <h3 className="text-sm font-bold text-slate-900">
                  Edit Playbook: {editingSkill.slashCommand || editingSkill.slug}
                </h3>
              </div>
              <button onClick={() => setEditingSkill(null)} className="text-slate-400 hover:text-slate-700">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-3 overflow-y-auto flex-1">
              <label className="text-xs font-semibold text-slate-700 block">Playbook Markdown</label>
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={12}
                className="w-full p-3 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 font-mono"
              />
            </div>

            <div className="px-5 py-3 border-t border-[#E5E5E5] flex items-center justify-between bg-[#F8FAFC]">
              {editingSkill.origin !== "plugin" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    await run("remove_skill", { id: editingSkill.id });
                    setEditingSkill(null);
                  }}
                  className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 rounded transition"
                >
                  Delete Skill
                </button>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => setEditingSkill(null)}
                  className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-[6px] transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleSaveSkill(editingSkill, editBody)}
                  className="px-4 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition flex items-center gap-1.5"
                  style={{ color: "#ffffff" }}
                >
                  <Check size={13} className="text-white" stroke="#ffffff" />
                  <span className="text-white" style={{ color: "#ffffff" }}>Save Skill</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          7. MODAL: TRUST PLUGIN DIALOG
         ===================================================================== */}
      {pendingTrustPlugin && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
          onClick={() => setTrustPluginId("")}
        >
          <div
            className="bg-white border border-[#E5E5E5] rounded-[12px] shadow-2xl max-w-md w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck size={20} className="text-amber-600" />
              <h3 className="text-sm font-bold text-slate-900">Trust Plugin: {pendingTrustPlugin.name}</h3>
            </div>
            <p className="text-xs text-[#64748B] leading-relaxed">
              Path: <code className="text-slate-800">{pendingTrustPlugin.sourcePath}</code>
            </p>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-[8px] space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span>Agent Capability:</span>
                <span className="font-semibold">{pendingTrustPlugin.hasAgent ? "Present" : "None"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Desktop Slot:</span>
                <span className="font-semibold">{pendingTrustPlugin.hasDesktop ? "Present" : "None"}</span>
              </div>
            </div>
            <p className="text-[11px] text-[#64748B] leading-relaxed">
              Trusting enables tool declaration and slot registration. Individual switches remain under your manual control.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#E5E5E5]">
              <button
                type="button"
                onClick={() => setTrustPluginId("")}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-[6px] transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  await run("trust_plugin", { id: pendingTrustPlugin.id });
                  setTrustPluginId("");
                }}
                className="px-4 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-[6px] transition"
                style={{ color: "#ffffff" }}
              >
                <span className="text-white" style={{ color: "#ffffff" }}>Confirm Trust</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
