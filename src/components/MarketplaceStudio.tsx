import React, { useState, useMemo } from "react";
import { ArrowLeft, Check, Download, ExternalLink, Key, Lock, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useOmni } from "../store";
import {
  MARKETPLACE_CATALOG,
  isItemInstalled,
  installMarketplaceItem,
  removeMarketplaceItem,
  type MarketplaceCatalogItem,
} from "../kernel/marketplaceCatalog";

export default function MarketplaceStudio() {
  const run = useOmni((s) => s.run);
  const snap = useOmni((s) => s.snap);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);

  const [sourceTab, setSourceTab] = useState<"included" | "store">("included");
  const [kindFilter, setKindFilter] = useState<"all" | "mcp" | "plugin" | "skill">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [targetBotScope, setTargetBotScope] = useState<string>(snap?.activeProfileId || "");
  const [gitRepoUrl, setGitRepoUrl] = useState<string>("");
  const [configuringItemId, setConfiguringItemId] = useState<string | null>(null);
  const [secretKeyInput, setSecretKeyInput] = useState<string>("");
  const [statusToast, setStatusToast] = useState<string>(
    "Add saves a server on this computer. Install Git clones the repository and saves any SKILL.md it contains."
  );
  const allItems = MARKETPLACE_CATALOG;

  const configuringItem = useMemo(() => {
    if (!configuringItemId) return null;
    return allItems.find((i) => i.id === configuringItemId) || null;
  }, [configuringItemId, allItems]);

  const targetProfileName = useMemo(() => {
    if (!targetBotScope) return "All Workspace Bots";
    const found = snap?.profiles.find((p) => p.id === targetBotScope);
    if (!found) return "Selected Bot";
    const h = found.handle || found.displayName;
    return h.startsWith("@") ? h : `@${h}`;
  }, [targetBotScope, snap]);

  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      const matchTab = item.tabSource === sourceTab;
      const matchKind = kindFilter === "all" || item.kind === kindFilter;
      const query = searchQuery.trim().toLowerCase();
      const matchSearch =
        !query ||
        item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.authorOrRepo.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query);
      return matchTab && matchKind && matchSearch;
    });
  }, [allItems, sourceTab, kindFilter, searchQuery]);

  // Install / Remove handler connecting to real backend commands
  const handleToggleInstall = async (item: MarketplaceCatalogItem) => {
    if (!snap) return;
    const installed = isItemInstalled(item, snap);

    if (installed) {
      try {
        const msg = await removeMarketplaceItem(item, snap, run);
        setStatusToast(msg);
      } catch (err) {
        setStatusToast(`Error removing ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (item.requiresKey) {
      setConfiguringItemId(item.id);
      setSecretKeyInput("");
      return;
    }

    try {
      const msg = await installMarketplaceItem(item, targetBotScope, run);
      setStatusToast(msg);
    } catch (err) {
      setStatusToast(`Error installing ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSaveVaultSecretAndInstall = async () => {
    if (!configuringItem) return;
    const key = secretKeyInput.trim();
    if (!key) {
      setStatusToast("Please enter a valid credential or key to authorize this integration.");
      return;
    }

    try {
      const msg = await installMarketplaceItem(configuringItem, targetBotScope, run, key);
      setConfiguringItemId(null);
      setSecretKeyInput("");
      setStatusToast(`🔒 Secret saved in vault: ${msg}`);
    } catch (err) {
      setStatusToast(`Failed to configure key for ${configuringItem.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleInstallFromGit = async () => {
    const raw = gitRepoUrl.trim();
    if (!raw) return;
    try {
      const res = await run("install_git_package", { url: raw, profileId: targetBotScope });
      setStatusToast(res?.toast || "Git install did not run. Restart the desktop app so the clone command is loaded.");
    } catch (err) {
      setStatusToast(`Failed to install from Git: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex-1 h-full bg-[#FAFAFA] text-[#0F172A] p-6 overflow-y-auto space-y-5 font-sans select-none">
      {/* 1. TOP HEADER & NAVIGATION */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
            <button
              type="button"
              onClick={() => go("chat")}
              className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] text-[#0F172A] hover:border-[#111111] rounded-[6px] flex items-center gap-1.5 transition cursor-pointer shadow-xs"
              title="Back to Chat (Alt+Left)"
              aria-label="Back to Chat"
            >
              <ArrowLeft size={13} />
              <span>Back</span>
            </button>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">Marketplace</h1>
              <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full flex items-center gap-1">
                <Check size={11} /> Local store
              </span>
            </div>
            <p className="text-xs text-[#64748B] mt-0.5">
              Browse, configure, and install real MCP servers, plugin packages, and domain skills (`SKILL.md`) into your local SQLite store and active bot profiles.
            </p>
            <p className="text-xs font-mono text-emerald-700 mt-1 flex items-center gap-1">
              <Sparkles size={12} className="shrink-0" />
              <span>{statusToast}</span>
            </p>
          </div>
        </div>

        {/* Kind Filters */}
        <div className="flex items-center gap-1.5">
          {(
            [
              ["all", "All"],
              ["mcp", "MCP servers"],
              ["plugin", "Plugins"],
              ["skill", "Skills"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setKindFilter(id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-[6px] border transition cursor-pointer ${
                kindFilter === id
                  ? "bg-[#111111] text-white border-[#111111]"
                  : "bg-white text-[#0F172A] border-[#E5E5E5] hover:border-[#111111]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 2. TABS & BOT SCOPE SELECTOR & SEARCH */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[#E5E5E5] p-3 rounded-[6px]">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setSourceTab("included")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-[6px] cursor-pointer transition ${
              sourceTab === "included"
                ? "bg-[#111111] text-white"
                : "bg-white border border-[#E5E5E5] text-[#0F172A] hover:border-[#111111]"
            }`}
          >
            Included ({allItems.filter((i) => i.tabSource === "included").length})
          </button>
          <button
            onClick={() => setSourceTab("store")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-[6px] cursor-pointer transition ${
              sourceTab === "store"
                ? "bg-[#111111] text-white"
                : "bg-white border border-[#E5E5E5] text-[#0F172A] hover:border-[#111111]"
            }`}
          >
            Store ({allItems.filter((i) => i.tabSource === "store").length})
          </button>

          <div className="flex items-center gap-1.5 ml-2 text-xs">
            <span className="text-[#64748B] font-medium">Mount to:</span>
            <select
              value={targetBotScope}
              onChange={(e) => setTargetBotScope(e.target.value)}
              className="px-2.5 py-1 text-xs font-mono border border-[#E5E5E5] rounded bg-[#F8FAFC] text-[#0F172A] outline-none focus:border-[#111111]"
            >
              <option value="">All Workspace Bots</option>
              {snap?.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  @{p.handle || p.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Search Bar + 1-Click Git Installer */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-[#94A3B8]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search integrations..."
              className="pl-8 pr-3 py-1.5 text-xs border border-[#E5E5E5] rounded-[6px] bg-white text-[#0F172A] w-48 outline-none focus:border-[#111111]"
            />
          </div>

          <div className="flex items-center gap-1">
            <input
              value={gitRepoUrl}
              onChange={(e) => setGitRepoUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInstallFromGit();
              }}
              placeholder="https://github.com/org/repo.git"
              className="w-56 px-2.5 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded-[6px] bg-white text-[#0F172A] outline-none focus:border-[#111111]"
            />
            <button
              onClick={handleInstallFromGit}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer disabled:opacity-50 flex items-center gap-1"
            >
              <Plus size={13} />
              <span>Install Git</span>
            </button>
          </div>
        </div>
      </div>

      {/* 3. VAULT CREDENTIAL MODAL */}
      {configuringItem && (
        <div className="bg-amber-50/90 border border-amber-300 rounded-[6px] p-4 flex flex-wrap items-center justify-between gap-3 text-xs relative shadow-xs">
          <button
            type="button"
            onClick={() => setConfiguringItemId(null)}
            className="absolute top-2 right-2 p-1 text-amber-800 hover:text-black rounded hover:bg-amber-200/60 transition cursor-pointer"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
          <div className="space-y-1.5 flex-1 pr-6">
            <div className="font-bold text-amber-950 flex items-center gap-1.5">
              <Lock size={13} />
              <span>Configure Secret Key in OS Vault for {configuringItem.name}</span>
            </div>
            <p className="text-[11px] text-amber-900 leading-relaxed">
              {configuringItem.keyLabel || "Enter consumer API key or secret token"}. This key is encrypted in your local OS Keychain and will never be shared or written in plain URLs.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={secretKeyInput}
                onChange={(e) => setSecretKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveVaultSecretAndInstall();
                }}
                placeholder={configuringItem.keyLabel || "Paste API key or secret token..."}
                className="w-full max-w-md px-3 py-1.5 font-mono bg-white border border-amber-300 rounded-[6px] text-[#0F172A] outline-none focus:border-[#111111]"
              />
              {configuringItem.keyUrl && (
                <a
                  href={configuringItem.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2 py-1 text-[11px] text-amber-900 bg-amber-100 hover:bg-amber-200 rounded border border-amber-300 flex items-center gap-1 shrink-0"
                >
                  <Key size={11} />
                  <span>Get Key</span>
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveVaultSecretAndInstall}
              disabled={busy}
              className="px-3.5 py-1.5 font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer disabled:opacity-50"
            >
              Save to Vault & Add
            </button>
            <button
              onClick={() => setConfiguringItemId(null)}
              className="px-3 py-1.5 border border-amber-300 bg-white text-amber-950 rounded-[6px] hover:bg-amber-50 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 4. MARKETPLACE CARDS GRID */}
      {filteredItems.length === 0 ? (
        <div className="bg-white border border-[#E5E5E5] rounded-[6px] p-8 text-center text-xs text-[#64748B] space-y-2">
          <p className="font-semibold text-[#0F172A]">No integrations found</p>
          <p>Try adjusting your search query or switching categories.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredItems.map((item) => {
            const installed = snap ? isItemInstalled(item, snap) : false;

            return (
              <div
                key={item.id}
                className={`bg-white rounded-[6px] p-4 border flex flex-col justify-between gap-3 transition shadow-xs ${
                  installed ? "border-[#111111]" : "border-[#E5E5E5] hover:border-[#94A3B8]"
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 h-8 rounded-[6px] bg-[#111111] text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">
                        {item.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-[#0F172A]">{item.name}</span>
                          {item.verified && (
                            <span title="Verified by Ronic" className="text-blue-600">
                              <ShieldCheck size={13} />
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="px-1.5 py-0.2 text-[10px] font-mono bg-slate-100 text-[#64748B] rounded">
                            {item.kind.toUpperCase()}
                          </span>
                          {item.requiresKey && (
                            <span className="px-1.5 py-0.2 text-[10px] font-mono bg-amber-50 text-amber-700 border border-amber-200 rounded flex items-center gap-0.5">
                              <Key size={9} /> Key
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleToggleInstall(item)}
                      disabled={busy}
                      className={`px-3 py-1 text-xs font-semibold rounded-[6px] transition cursor-pointer flex items-center gap-1 disabled:opacity-50 ${
                        installed
                          ? "bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-300 group"
                          : "bg-[#111111] text-white hover:opacity-90"
                      }`}
                      title={installed ? "Click to remove from workspace" : "Install integration"}
                    >
                      {installed ? (
                        <>
                          <Check size={12} className="group-hover:hidden" />
                          <Trash2 size={12} className="hidden group-hover:inline text-rose-600" />
                          <span className="group-hover:hidden">Added</span>
                          <span className="hidden group-hover:inline">Remove</span>
                        </>
                      ) : (
                        <>
                          <Plus size={12} />
                          <span>Add</span>
                        </>
                      )}
                    </button>
                  </div>

                  <p className="text-xs text-[#64748B] leading-relaxed line-clamp-3">{item.description}</p>
                </div>

                <div className="pt-2.5 border-t border-[#F1F5F9] flex items-center justify-between text-[11px] font-mono text-[#64748B]">
                  <span className="truncate max-w-[140px] text-slate-700 font-medium">{item.authorOrRepo}</span>
                  <span className="px-2 py-0.5 rounded bg-slate-50 border border-slate-100 text-slate-600">
                    {item.category}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
