import React, { useState, useMemo, useEffect } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  ChevronDown,
  Sliders,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
  LogIn,
  Laptop,
  Folder,
  AlertTriangle,
  Globe,
} from "lucide-react";
import { useRonic } from "../store";
import { AppLogo } from "../ui/appLogos";
import {
  MARKETPLACE_CATALOG,
  isItemInstalled,
  isItemConnected,
  getItemStatus,
  getAuthenticatedMcpIds,
  getMcpAuthVault,
  saveMcpAuthRecord,
  removeMcpAuthRecord,
  installMarketplaceItem,
  removeMarketplaceItem,
  isPlaceholderCredential,
  type MarketplaceCatalogItem,
  type MarketplaceCategory,
  type McpAuthRecord,
  type AuthMethodType,
  type MarketplaceItemStatus,
} from "../kernel/marketplaceCatalog";
import { verifyMcpCredentials } from "../kernel/mcpAuthVerify";

const CATEGORY_CHIPS = [
  "All",
  "Password Managers",
  "Productivity",
  "Communication",
  "Design",
  "Code",
  "Data",
  "Sales & Marketing",
  "Finance",
  "Research",
  "Supercharge & Bots",
] as const;

interface SectionConfig {
  id: string;
  title: string;
  category: MarketplaceCategory;
  isRecommended?: boolean;
}

const SECTIONS: SectionConfig[] = [
  { id: "recommended", title: "Recommended for you", category: "Recommended for you", isRecommended: true },
  { id: "code", title: "Code", category: "Code" },
  { id: "data", title: "Data", category: "Data" },
  { id: "sales", title: "Sales & Marketing", category: "Sales & Marketing" },
  { id: "comm", title: "Communication", category: "Communication" },
  { id: "design", title: "Design", category: "Design" },
  { id: "productivity", title: "Productivity", category: "Productivity" },
  { id: "passwords", title: "Password Managers", category: "Password Managers" },
  { id: "finance", title: "Finance", category: "Finance" },
  { id: "research", title: "Research", category: "Research" },
  { id: "supercharge", title: "Supercharge & Bots", category: "Supercharge & Bots" },
];

const BOT_TEMPLATES = [
  {
    id: "fullstack",
    title: "Full-Stack Dev Agent",
    icon: "💻",
    description: "Equipped with Supabase, GitHub MCP, Sentry, Datadog, Docker, and Redis.",
    itemIds: ["mcp-supabase", "mcp-github", "mcp-sentry", "mcp-datadog", "mcp-docker", "mcp-redis"],
    tags: ["Supabase", "GitHub", "Sentry", "Datadog", "Docker", "Redis"],
  },
  {
    id: "researcher",
    title: "Deep Research Specialist",
    icon: "🔬",
    description: "Equipped with Parallel, Exa, Perplexity, Context.dev, and Firecrawl.",
    itemIds: ["mcp-parallel", "mcp-exa", "mcp-perplexity", "mcp-context-dev", "mcp-firecrawl"],
    tags: ["Parallel", "Exa", "Perplexity", "Context.dev", "Firecrawl"],
  },
  {
    id: "design-ops",
    title: "Design System & Asset Studio",
    icon: "🎨",
    description: "Equipped with Canva, Google Slides, Mobbin, Higgsfield, and Docs Canvas.",
    itemIds: ["mcp-canva", "mcp-google-slides", "mcp-mobbin", "mcp-higgsfield", "plugin-docs-canvas"],
    tags: ["Canva", "Google Slides", "Mobbin", "Higgsfield", "Docs Canvas"],
  },
  {
    id: "growth-sales",
    title: "Growth & Outbound SDR",
    icon: "🚀",
    description: "Equipped with Apollo.io, Granola, Gmail, Klaviyo, and Brevo.",
    itemIds: ["mcp-apollo", "mcp-granola", "mcp-gmail", "mcp-klaviyo", "mcp-brevo"],
    tags: ["Apollo.io", "Granola", "Gmail", "Klaviyo", "Brevo"],
  },
  {
    id: "quant",
    title: "Quant & Financial Desk",
    icon: "📊",
    description: "Equipped with Shopify Merchant, Kraken, Ramp, Finance MCP, and X Money.",
    itemIds: ["mcp-shopify", "mcp-kraken", "mcp-ramp", "mcp-finance", "mcp-x-money"],
    tags: ["Shopify", "Kraken", "Ramp", "Finance", "X Money"],
  },
];


function AdvancedAuthFields({
  show,
  onToggle,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  scopes,
  setScopes,
  redirectUri,
  setRedirectUri,
  serviceAccountJson,
  setServiceAccountJson,
  endpointUrl,
  setEndpointUrl,
  customHeaders,
  setCustomHeaders,
}: {
  show: boolean;
  onToggle: () => void;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  scopes: string;
  setScopes: (v: string) => void;
  redirectUri: string;
  setRedirectUri: (v: string) => void;
  serviceAccountJson: string;
  setServiceAccountJson: (v: string) => void;
  endpointUrl: string;
  setEndpointUrl: (v: string) => void;
  customHeaders: string;
  setCustomHeaders: (v: string) => void;
}) {
  return (
    <div className="pt-2 border-t border-slate-200/60">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between py-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 transition-colors cursor-pointer group"
      >
        <span className="flex items-center gap-1.5">
          <Sliders size={13} className="text-slate-400 group-hover:text-slate-600" />
          <span>Advanced Authentication (Optional)</span>
        </span>
        <ChevronDown size={14} className={`text-slate-400 transition-transform duration-200 ${show ? "rotate-180" : ""}`} />
      </button>

      {show && (
        <div className="p-3.5 bg-slate-50/80 rounded-2xl border border-slate-200/80 space-y-3 mt-1.5 animate-in fade-in duration-150">
          <p className="text-[11px] text-slate-500">
            Configure custom enterprise OAuth credentials, GCP service accounts, or private endpoints.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="block space-y-1">
              <span className="text-[10.5px] font-medium text-slate-600">Custom OAuth Client ID</span>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="e.g. 123456789.apps.googleusercontent.com"
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[10.5px] font-medium text-slate-600">Custom OAuth Client Secret</span>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="e.g. GOCSPX-..."
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="block space-y-1">
              <span className="text-[10.5px] font-medium text-slate-600">Custom Scopes (comma separated)</span>
              <input
                type="text"
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
                placeholder="https://www.googleapis.com/auth/documents, ..."
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[10.5px] font-medium text-slate-600">Redirect URI Override</span>
              <input
                type="text"
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
                placeholder="http://localhost:54321/callback"
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[10.5px] font-medium text-slate-600">Custom Base URL / Endpoint Override</span>
            <input
              type="text"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="e.g. http://localhost:8000 or custom proxy"
              className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10.5px] font-medium text-slate-600">Google Service Account / Private Key JSON</span>
            <textarea
              value={serviceAccountJson}
              onChange={(e) => setServiceAccountJson(e.target.value)}
              placeholder='{ "type": "service_account", "project_id": "...", "private_key": "..." }'
              className="w-full h-20 p-2 text-[11px] font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400 resize-y leading-tight"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10.5px] font-medium text-slate-600">Custom Headers / Config JSON</span>
            <input
              type="text"
              value={customHeaders}
              onChange={(e) => setCustomHeaders(e.target.value)}
              placeholder='{ "X-Custom-Auth": "bearer-token" }'
              className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800 outline-none focus:border-slate-400"
            />
          </label>
        </div>
      )}
    </div>
  );
}

export default function MarketplaceStudio() {
  const run = useRonic((s) => s.run);
  const snap = useRonic((s) => s.snap);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);

  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showConnectedOnly, setShowConnectedOnly] = useState<boolean>(false);
  const [showBotTemplatesModal, setShowBotTemplatesModal] = useState<boolean>(false);
  const [targetBotScope, setTargetBotScope] = useState<string>(snap?.activeProfileId || "");
  const [gitRepoUrl, setGitRepoUrl] = useState<string>("");

  // Auth Vault & Authentication state
  const [authVault, setAuthVault] = useState<Record<string, McpAuthRecord>>(() => getMcpAuthVault());
  const [authenticatedIds, setAuthenticatedIds] = useState<Set<string>>(() => getAuthenticatedMcpIds());

  // Configuration Modal state
  const [configuringItemId, setConfiguringItemId] = useState<string | null>(null);
  const [isManagingConnected, setIsManagingConnected] = useState<boolean>(false);
  const [secretKeyInput, setSecretKeyInput] = useState<string>("");
  const [showSecretPassword, setShowSecretPassword] = useState<boolean>(false);
  const [multiFieldInputs, setMultiFieldInputs] = useState<Record<string, string>>({});
  const [showMultiFieldPassword, setShowMultiFieldPassword] = useState<Record<string, boolean>>({});
  const [oauthIdentityInput, setOauthIdentityInput] = useState<string>("");
  const [isAuthorizingOAuth, setIsAuthorizingOAuth] = useState<boolean>(false);
  const [manualTokenMode, setManualTokenMode] = useState<boolean>(false);
  const [showAdvancedAuth, setShowAdvancedAuth] = useState<boolean>(false);
  const [advancedClientId, setAdvancedClientId] = useState<string>("");
  const [advancedClientSecret, setAdvancedClientSecret] = useState<string>("");
  const [advancedScopes, setAdvancedScopes] = useState<string>("");
  const [advancedRedirectUri, setAdvancedRedirectUri] = useState<string>("http://localhost:54321/callback");
  const [advancedServiceAccountJson, setAdvancedServiceAccountJson] = useState<string>("");
  const [advancedEndpointUrl, setAdvancedEndpointUrl] = useState<string>("");
  const [advancedCustomHeaders, setAdvancedCustomHeaders] = useState<string>("");
  const [localPathInput, setLocalPathInput] = useState<string>("C:/Workspace");

  const [statusToast, setStatusToast] = useState<string>(
    "Explore, connect, and install verified MCP servers and bot tools."
  );

  const allItems = MARKETPLACE_CATALOG;

  // Clean up legacy stale IDs that were marked without credentials for items that require auth
  useEffect(() => {
    try {
      const vault = getMcpAuthVault();
      setAuthVault(vault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
    } catch {}
  }, []);

  const configuringItem = useMemo(() => {
    if (!configuringItemId) return null;
    return allItems.find((i) => i.id === configuringItemId) || null;
  }, [configuringItemId, allItems]);

  const activeAuthRecord = useMemo(() => {
    if (!configuringItem) return null;
    return authVault[configuringItem.id] || null;
  }, [configuringItem, authVault]);

  const installedCount = useMemo(() => {
    if (!snap) return 0;
    return allItems.filter((item) => isItemConnected(item, snap, authenticatedIds, authVault)).length;
  }, [allItems, snap, authenticatedIds, authVault]);

  const matchesCategory = (item: MarketplaceCatalogItem, cat: string) => {
    if (cat === "All") return true;
    if (cat === "Recommended for you") return Boolean(item.recommended);
    if (cat === "Code") {
      return item.category === "Code" || item.category === "Code & Reverse Engineering";
    }
    if (cat === "Finance") {
      return item.category === "Finance" || item.category === "Quant & FinTech";
    }
    if (cat === "Supercharge & Bots") {
      return item.category === "Supercharge & Bots" || item.id.includes("superpowers");
    }
    return item.category === cat;
  };

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allItems.filter((item) => {
      if (showConnectedOnly && snap && !isItemConnected(item, snap, authenticatedIds, authVault)) {
        return false;
      }
      if (selectedCategory !== "All" && !matchesCategory(item, selectedCategory)) {
        return false;
      }
      if (q) {
        return (
          item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.authorOrRepo.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q) ||
          (item.authConfig?.providerName && item.authConfig.providerName.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [allItems, searchQuery, selectedCategory, showConnectedOnly, snap, authenticatedIds, authVault]);

  const openConfigModalForItem = (item: MarketplaceCatalogItem, managing = false) => {
    setConfiguringItemId(item.id);
    setIsManagingConnected(managing);
    setSecretKeyInput("");
    setShowSecretPassword(false);
    setIsAuthorizingOAuth(false);
    setManualTokenMode(false);
    setOauthIdentityInput("");
    setShowAdvancedAuth(false);
    const existingAdv = authVault[item.id]?.advanced;
    setAdvancedClientId(existingAdv?.clientId || "");
    setAdvancedClientSecret(existingAdv?.clientSecret || "");
    setAdvancedScopes(existingAdv?.customScopes?.join(", ") || "");
    setAdvancedRedirectUri(existingAdv?.redirectUri || "http://localhost:54321/callback");
    setAdvancedServiceAccountJson(existingAdv?.serviceAccountJson || "");
    setAdvancedEndpointUrl(existingAdv?.endpointUrl || "");
    setAdvancedCustomHeaders(existingAdv?.customHeaders ? JSON.stringify(existingAdv.customHeaders) : "");

    // Initialize multi-field default values
    const initialFields: Record<string, string> = {};
    if (item.authConfig?.fields) {
      const existing = authVault[item.id]?.config || {};
      for (const f of item.authConfig.fields) {
        initialFields[f.key] = existing[f.key] || f.defaultValue || "";
      }
    }
    setMultiFieldInputs(initialFields);
  };

  const handleToggleInstall = async (item: MarketplaceCatalogItem) => {
    if (!snap) return;
    const status = getItemStatus(item, snap, authenticatedIds, authVault);

    // If already connected, open management card so user can review details or disconnect
    if (status === "connected") {
      openConfigModalForItem(item, true);
      return;
    }

    // Determine auth requirements
    const authMethod = item.authConfig?.method || (item.requiresAuth || item.requiresKey ? "api_key" : "none");

    if (
      authMethod === "oauth" ||
      authMethod === "api_key" ||
      authMethod === "multi_field" ||
      authMethod === "local_path" ||
      authMethod === "local_daemon"
    ) {
      openConfigModalForItem(item, false);
      return;
    }

    // Zero-config tools install directly
    try {
      const msg = await installMarketplaceItem(item, targetBotScope, run);
      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setStatusToast(msg);
    } catch (err) {
      setStatusToast(`Error installing ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- OAuth Authorization Trigger ---
  const handleOAuthConnect = async (customIdentity?: string, tokenOverride?: string) => {
    if (!configuringItem) return;

    const identity = (customIdentity || oauthIdentityInput).trim();
    const token = (tokenOverride || secretKeyInput).trim();
    const svcJson = advancedServiceAccountJson.trim();

    if (!identity) {
      setStatusToast(`Please provide your account email or identity for ${configuringItem.name}.`);
      return;
    }
    if (!token && !svcJson) {
      setStatusToast(`Please provide an OAuth Access Token, Bearer Key, or Service Account JSON for ${configuringItem.name}.`);
      return;
    }

    setIsAuthorizingOAuth(true);

    try {
      let customHeadersObj: Record<string, string> | undefined = undefined;
      if (advancedCustomHeaders.trim()) {
        try { customHeadersObj = JSON.parse(advancedCustomHeaders.trim()); } catch {}
      }

      const advanced = (showAdvancedAuth || advancedClientId || advancedClientSecret || advancedEndpointUrl || svcJson) ? {
        clientId: advancedClientId.trim() || undefined,
        clientSecret: advancedClientSecret.trim() || undefined,
        customScopes: advancedScopes.trim() ? advancedScopes.split(",").map(s => s.trim()) : undefined,
        redirectUri: advancedRedirectUri.trim() || undefined,
        serviceAccountJson: svcJson || undefined,
        endpointUrl: advancedEndpointUrl.trim() || undefined,
        customHeaders: customHeadersObj,
      } : undefined;

      const checked = await verifyMcpCredentials(configuringItem, {
        identity,
        secret: token || svcJson,
        advanced,
      }, run);
      const msg = await installMarketplaceItem(configuringItem, targetBotScope || snap?.activeProfileId || "", run, {
        identity: checked.identity,
        secretKey: token || svcJson,
        advanced,
        verified: true,
      });

      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setIsAuthorizingOAuth(false);
      setConfiguringItemId(null);
      setStatusToast(msg || checked.detail);
    } catch (err) {
      setIsAuthorizingOAuth(false);
      setStatusToast(`Failed to connect ${configuringItem.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- Multi-Field Submission ---
  const handleSaveMultiFieldAndConnect = async () => {
    if (!configuringItem) return;
    const fields = configuringItem.authConfig?.fields || [];
    for (const f of fields) {
      if (f.required && !multiFieldInputs[f.key]?.trim()) {
        setStatusToast(`Please fill in required field: ${f.label}`);
        return;
      }
    }

    // Validate Supabase project URL if applicable
    if (configuringItem.id === "mcp-supabase") {
      const url = multiFieldInputs.projectUrl?.trim();
      if (!url || !url.startsWith("https://")) {
        setStatusToast("Supabase needs a project URL that starts with https://.");
        return;
      }
    }

    try {
      const primarySecret =
        multiFieldInputs.accessToken ||
        multiFieldInputs.serviceKey ||
        multiFieldInputs.apiKey ||
        multiFieldInputs.authToken ||
        multiFieldInputs.keySecret ||
        multiFieldInputs.password ||
        multiFieldInputs.connectionUri ||
        multiFieldInputs.connectionUrl ||
        "";
      if (primarySecret && isPlaceholderCredential(primarySecret)) {
        setStatusToast(`${configuringItem.name} needs a real credential. It was not marked connected.`);
        return;
      }

      let customHeadersObj: Record<string, string> | undefined = undefined;
      if (advancedCustomHeaders.trim()) {
        try { customHeadersObj = JSON.parse(advancedCustomHeaders.trim()); } catch {}
      }

      const advanced = (showAdvancedAuth || advancedEndpointUrl || advancedClientId) ? {
        clientId: advancedClientId.trim() || undefined,
        clientSecret: advancedClientSecret.trim() || undefined,
        endpointUrl: advancedEndpointUrl.trim() || undefined,
        customHeaders: customHeadersObj,
      } : undefined;

      const checked = await verifyMcpCredentials(configuringItem, {
        secret: primarySecret,
        config: multiFieldInputs,
        advanced,
      }, run);
      const msg = await installMarketplaceItem(configuringItem, targetBotScope || snap?.activeProfileId || "", run, {
        identity: checked.identity,
        secretKey: primarySecret,
        config: multiFieldInputs,
        advanced,
        verified: true,
      });

      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setConfiguringItemId(null);
      setMultiFieldInputs({});
      setStatusToast(msg || checked.detail);
    } catch (err) {
      setStatusToast(`Failed to connect ${configuringItem.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- Single API Key Submission ---
  const handleSaveApiKeyAndConnect = async () => {
    if (!configuringItem) return;
    const key = secretKeyInput.trim();
    if (!key) {
      setStatusToast(`Please enter an API key or token for ${configuringItem.name}.`);
      return;
    }

    try {
      const checked = await verifyMcpCredentials(configuringItem, { secret: key }, run);
      const msg = await installMarketplaceItem(configuringItem, targetBotScope, run, {
        secretKey: key,
        identity: checked.identity,
        verified: true,
      });
      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setConfiguringItemId(null);
      setSecretKeyInput("");
      setStatusToast(msg || checked.detail);
    } catch (err) {
      setStatusToast(`Failed to connect ${configuringItem.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- Local Daemon (Docker) Submission ---
  const handleConnectLocalDaemon = async () => {
    if (!configuringItem) return;
    try {
      const checked = await verifyMcpCredentials(configuringItem, {}, run);
      const msg = await installMarketplaceItem(configuringItem, targetBotScope, run, {
        identity: checked.identity,
        verified: true,
      });
      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setConfiguringItemId(null);
      setStatusToast(msg || checked.detail);
    } catch (err) {
      setStatusToast(`Docker daemon connection error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- Local Path (Filesystem) Submission ---
  const handleConnectLocalPath = async () => {
    if (!configuringItem) return;
    try {
      const checked = await verifyMcpCredentials(configuringItem, {
        identity: localPathInput,
        config: { rootPath: localPathInput },
      }, run);
      const msg = await installMarketplaceItem(configuringItem, targetBotScope, run, {
        identity: checked.identity,
        config: { rootPath: localPathInput },
        verified: true,
      });
      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setConfiguringItemId(null);
      setStatusToast(msg || checked.detail);
    } catch (err) {
      setStatusToast(`Failed to mount directory: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- Disconnect / Remove ---
  const handleDisconnectItem = async (item: MarketplaceCatalogItem) => {
    if (!snap) return;
    try {
      const msg = await removeMarketplaceItem(item, snap, run);
      const updatedVault = getMcpAuthVault();
      setAuthVault(updatedVault);
      setAuthenticatedIds(getAuthenticatedMcpIds());
      setConfiguringItemId(null);
      setIsManagingConnected(false);
      setStatusToast(msg);
    } catch (err) {
      setStatusToast(`Error removing ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleInstallFromGit = async () => {
    const raw = gitRepoUrl.trim();
    if (!raw) return;
    try {
      const res = await run("install_git_package", { url: raw, profileId: targetBotScope });
      setStatusToast(
        (res as { toast?: string })?.toast ||
          "Git repository package installed successfully."
      );
      setGitRepoUrl("");
    } catch (err) {
      setStatusToast(`Failed to install from Git: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleApplyTemplate = async (tmpl: (typeof BOT_TEMPLATES)[number]) => {
    if (!snap) return;
    const targetItems = allItems.filter((i) => tmpl.itemIds.includes(i.id));
    const toInstall = targetItems.filter((i) => !isItemConnected(i, snap, authenticatedIds, authVault));

    if (toInstall.length === 0) {
      setStatusToast(`All tools from "${tmpl.title}" are already installed and connected.`);
      setShowBotTemplatesModal(false);
      return;
    }

    let installedCount = 0;
    const needsAuthList: MarketplaceCatalogItem[] = [];

    for (const item of toInstall) {
      const authMethod = item.authConfig?.method || (item.requiresAuth || item.requiresKey ? "api_key" : "none");
      if (authMethod !== "none") {
        needsAuthList.push(item);
      } else {
        try {
          await installMarketplaceItem(item, targetBotScope, run);
          installedCount++;
        } catch (e) {
          console.error(`Failed to install ${item.name}:`, e);
        }
      }
    }

    const updatedVault = getMcpAuthVault();
    setAuthVault(updatedVault);
    setAuthenticatedIds(getAuthenticatedMcpIds());

    if (needsAuthList.length > 0) {
      setStatusToast(
        `✓ Installed ${installedCount} zero-config tools. Please authenticate: ${needsAuthList.map((i) => i.name).join(", ")}.`
      );
      // Open modal for the first item that requires credentials
      openConfigModalForItem(needsAuthList[0]);
    } else {
      setStatusToast(
        `✓ Installed all ${installedCount} tools from "${tmpl.title}" to ${targetBotScope ? `active bot` : "workspace"}.`
      );
    }
    setShowBotTemplatesModal(false);
  };

  const renderAppCard = (item: MarketplaceCatalogItem) => {
    const status = snap ? getItemStatus(item, snap, authenticatedIds, authVault) : "not_installed";
    const authMethod = item.authConfig?.method || (item.requiresAuth || item.requiresKey ? "api_key" : "none");
    const isConnected = status === "connected";
    const isNeedsAuth = status === "needs_auth";
    const record = authVault[item.id];

    // Method Badge styling & label
    const authBadge = (() => {
      if (authMethod === "oauth") {
        return (
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200/80 flex items-center gap-0.5 shrink-0"
            title="Authenticates via Browser OAuth 2.0"
          >
            <Globe size={9} />
            <span>OAUTH</span>
          </span>
        );
      }
      if (authMethod === "multi_field") {
        return (
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-purple-50 text-purple-700 border border-purple-200/80 flex items-center gap-0.5 shrink-0"
            title="Configured with multi-field credentials"
          >
            <Key size={9} />
            <span>LOGIN</span>
          </span>
        );
      }
      if (authMethod === "api_key") {
        return (
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200/80 flex items-center gap-0.5 shrink-0"
            title="Requires API Key / Auth Token"
          >
            <Key size={9} />
            <span>KEY</span>
          </span>
        );
      }
      if (authMethod === "local_daemon") {
        return (
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-0.5 shrink-0"
            title="Connects to local machine daemon"
          >
            <Laptop size={9} />
            <span>LOCAL</span>
          </span>
        );
      }
      return null;
    })();

    // Action button label
    const actionLabel = (() => {
      if (authMethod === "oauth") return "Connect";
      if (authMethod === "multi_field") return "Configure";
      if (authMethod === "local_daemon") return "Connect";
      if (authMethod === "api_key") return "Connect";
      return "Add";
    })();

    return (
      <div
        key={item.id}
        onClick={() => {
          if (isConnected) {
            openConfigModalForItem(item, true);
          } else {
            handleToggleInstall(item);
          }
        }}
        className="group relative flex flex-col justify-between p-4 rounded-2xl bg-white hover:bg-slate-50/90 border border-slate-200/80 hover:border-slate-300 shadow-2xs hover:shadow-xs transition-all duration-150 cursor-pointer min-h-[110px]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 shadow-2xs flex items-center justify-center bg-slate-50 border border-slate-100 mt-0.5">
              <AppLogo
                id={item.id}
                name={item.name}
                url={item.mcpConfig?.url || item.keyUrl || undefined}
                command={item.mcpConfig?.command}
                size={38}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-semibold text-slate-800 group-hover:text-black truncate">
                  {item.name}
                </span>
                {authBadge}
              </div>
              {isConnected && record?.accountIdentity && (
                <div className="text-[10px] text-emerald-700 font-mono truncate max-w-[200px] mt-0.5 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span className="truncate">{record.accountIdentity}</span>
                </div>
              )}
              <p className="text-[11.5px] text-slate-500 line-clamp-2 mt-1 leading-snug">
                {item.description}
              </p>
            </div>
          </div>

          {/* Action Button */}
          <div className="shrink-0 pt-0.5">
            {isConnected ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openConfigModalForItem(item, true);
                }}
                disabled={busy}
                className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all duration-150 cursor-pointer bg-emerald-50 text-emerald-700 border border-emerald-200/90 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 group/btn shadow-2xs active:scale-95"
              >
                <span className="group-hover/btn:hidden flex items-center gap-1">
                  <Check size={11} strokeWidth={2.5} />
                  <span>Connected</span>
                </span>
                <span className="hidden group-hover/btn:inline">Manage</span>
              </button>
            ) : isNeedsAuth ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openConfigModalForItem(item, false);
                }}
                disabled={busy}
                className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all duration-150 cursor-pointer bg-amber-500 hover:bg-amber-600 text-white shadow-xs active:scale-95 flex items-center gap-1"
                title="Installed on machine but requires authentication to activate tools"
              >
                <Key size={11} />
                <span>Authenticate</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleInstall(item);
                }}
                disabled={busy}
                className={`text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all duration-150 cursor-pointer active:scale-95 ${
                  authMethod !== "none"
                    ? "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-black border border-slate-200"
                }`}
              >
                {actionLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const isGroupedView = selectedCategory === "All" && !searchQuery.trim() && !showConnectedOnly;

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      {/* ─── MODAL CONTAINER ─── */}
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        
        {/* ─── TOP HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100 bg-white">
          {/* Top Info Row: Back & Connected Count & Avatar Stack */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => go("chat")}
                className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-2.5 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                title="Back to Chat (Alt+Left)"
              >
                <ArrowLeft size={15} />
                <span>Back</span>
              </button>
            </div>

            {/* Connected Badge */}
            <button
              type="button"
              onClick={() => {
                setShowConnectedOnly((prev) => !prev);
                if (!showConnectedOnly) setSelectedCategory("All");
              }}
              className={`flex items-center gap-2.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer ${
                showConnectedOnly
                  ? "bg-emerald-50 text-emerald-800 border border-emerald-300 shadow-xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
              title="Click to view installed and connected apps"
            >
              <div className="flex items-center -space-x-1.5 overflow-hidden">
                <span className="inline-block w-4 h-4 rounded-full bg-emerald-500 border border-white ring-1 ring-emerald-500/20" />
                <span className="inline-block w-4 h-4 rounded-full bg-blue-500 border border-white ring-1 ring-blue-500/20" />
                <span className="inline-block w-4 h-4 rounded-full bg-purple-500 border border-white ring-1 ring-purple-500/20" />
              </div>
              <span>{installedCount} connected</span>
              <ChevronRight size={13} className="text-slate-400" />
            </button>
          </div>

          {/* Search Bar + Bot Templates + Close */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search
                size={17}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search apps, OAuth providers, MCP tools, and skills..."
                className="w-full pl-11 pr-10 py-2.5 text-sm bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200/90 rounded-full text-slate-800 placeholder:text-slate-400 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all shadow-2xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5 rounded-full cursor-pointer"
                >
                  <X size={15} />
                </button>
              )}
            </div>

            {/* Bot Templates Button */}
            <button
              type="button"
              onClick={() => setShowBotTemplatesModal(true)}
              className="shrink-0 flex items-center gap-2 px-4 py-2.5 text-xs font-bold bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-800 rounded-full transition-all shadow-xs cursor-pointer active:scale-95"
            >
              <span className="text-sm">🎱</span>
              <span className="hidden sm:inline">Bot templates</span>
              <ArrowUpRight size={13} className="text-slate-400" />
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={() => go("chat")}
              className="shrink-0 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
              title="Close Marketplace"
            >
              <X size={20} />
            </button>
          </div>

          {/* Category Chips Bar */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1">
            {CATEGORY_CHIPS.map((cat) => {
              const isActive = selectedCategory === cat && !showConnectedOnly;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setSelectedCategory(cat);
                    setShowConnectedOnly(false);
                  }}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-all duration-150 shrink-0 cursor-pointer ${
                    isActive
                      ? "bg-zinc-800 text-white shadow-xs"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── SCROLLABLE CONTENT BODY ─── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-7">
          {/* Grouped View (Default) */}
          {isGroupedView ? (
            SECTIONS.map((section) => {
              const sectionItems = allItems.filter((i) => {
                if (section.isRecommended) return Boolean(i.recommended);
                return matchesCategory(i, section.category);
              });
              if (sectionItems.length === 0) return null;

              return (
                <div key={section.id} className="space-y-2">
                  <div className="flex items-center justify-between px-2">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      {section.title}
                    </h2>
                    <span className="text-[11px] font-mono text-slate-400">
                      {sectionItems.length} tools
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    {sectionItems.map((item) => renderAppCard(item))}
                  </div>
                </div>
              );
            })
          ) : (
            /* Flat Filtered Results View */
            <div className="space-y-3">
              <div className="flex items-center justify-between px-2">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  {showConnectedOnly ? "Installed & Connected Tools" : `Results for "${selectedCategory}"`}
                </span>
                <span className="text-xs font-medium text-slate-400">
                  {filteredItems.length} tool{filteredItems.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {filteredItems.length > 0 ? (
                  filteredItems.map((item) => renderAppCard(item))
                ) : (
                  <div className="col-span-full py-14 text-center space-y-2 bg-white rounded-2xl border border-slate-200/80 p-8 shadow-2xs">
                    <p className="text-sm font-semibold text-slate-700">No matching integrations found</p>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto">
                      Try clearing filters or search by tool keyword like &quot;database&quot;, &quot;google&quot;, or &quot;linear&quot;.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Git URL Custom Install Card */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 space-y-3 shadow-2xs">
            <div className="flex items-center gap-2">
              <span className="text-base">📦</span>
              <div>
                <h3 className="text-xs font-bold text-slate-800">Install Custom MCP Server via Git</h3>
                <p className="text-[11px] text-slate-500">
                  Clone and mount custom MCP tools directly from GitHub or GitLab.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={gitRepoUrl}
                onChange={(e) => setGitRepoUrl(e.target.value)}
                placeholder="https://github.com/organization/custom-mcp-server.git"
                className="flex-1 px-4 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all shadow-2xs"
              />
              <button
                type="button"
                onClick={handleInstallFromGit}
                disabled={busy || !gitRepoUrl.trim()}
                className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all shadow-xs disabled:opacity-40 cursor-pointer"
              >
                Install Repo
              </button>
            </div>
          </div>
        </div>

        {/* ─── BOTTOM STATUS BAR ─── */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2 truncate pr-4">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            <span className="truncate">{statusToast}</span>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span>Scoped to: {targetBotScope || "Global Workspace"}</span>
          </div>
        </div>
      </div>

      {/* ─── COMPREHENSIVE AUTHENTICATION & CONFIGURATION MODAL ─── */}
      {configuringItem && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 p-6 space-y-5 animate-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl overflow-hidden shrink-0 border border-slate-100 bg-slate-50 flex items-center justify-center shadow-xs">
                  <AppLogo
                    id={configuringItem.id}
                    name={configuringItem.name}
                    url={configuringItem.mcpConfig?.url || configuringItem.keyUrl || undefined}
                    command={configuringItem.mcpConfig?.command}
                    size={48}
                  />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-slate-900">
                      {isManagingConnected ? configuringItem.name : `Connect ${configuringItem.name}`}
                    </h3>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                      {configuringItem.category}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 pt-0.5">
                    {isManagingConnected
                      ? "Connected integration and security details"
                      : "Verified integration with encrypted vault credential storage"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setConfiguringItemId(null);
                  setIsManagingConnected(false);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-full hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Description Card */}
            <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-100 space-y-2">
              <p className="text-xs text-slate-700 leading-relaxed">
                {configuringItem.authConfig?.helpText || configuringItem.description}
              </p>
              {configuringItem.authConfig?.keyUrl && (
                <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-200/60">
                  <span className="text-slate-500 font-medium">Developer Documentation:</span>
                  <a
                    href={configuringItem.authConfig.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 hover:underline"
                  >
                    <span>Developer Console</span>
                    <ExternalLink size={11} />
                  </a>
                </div>
              )}
            </div>

            {/* ======================================================== */}
            {/* VIEW 1: ALREADY CONNECTED & MANAGING                     */}
            {/* ======================================================== */}
            {isManagingConnected ? (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-50/70 border border-emerald-200/80 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-emerald-800 text-xs font-bold">
                      <ShieldCheck size={16} className="text-emerald-600" />
                      <span>Authenticated & Ready</span>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      Encrypted in Vault
                    </span>
                  </div>
                  <div className="text-xs text-slate-700 space-y-1 pt-1 border-t border-emerald-200/50">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Connected Account:</span>
                      <span className="font-semibold text-slate-900">{activeAuthRecord?.accountIdentity || "Active Account"}</span>
                    </div>
                    {activeAuthRecord?.credentialMask && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Credential / Mask:</span>
                        <span className="font-mono text-slate-800">{activeAuthRecord.credentialMask}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Authentication Method:</span>
                      <span className="uppercase text-[11px] font-bold text-slate-700">{activeAuthRecord?.authMethod || configuringItem.authConfig?.method || "Verified"}</span>
                    </div>
                    {activeAuthRecord?.advanced?.clientId && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Custom Client ID:</span>
                        <span className="font-mono text-slate-800 text-[11px] truncate max-w-[200px]">{activeAuthRecord.advanced.clientId}</span>
                      </div>
                    )}
                    {activeAuthRecord?.advanced?.endpointUrl && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">Custom Endpoint:</span>
                        <span className="font-mono text-slate-800 text-[11px] truncate max-w-[200px]">{activeAuthRecord.advanced.endpointUrl}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => handleDisconnectItem(configuringItem)}
                    disabled={busy}
                    className="px-4 py-2 text-xs font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <Trash2 size={13} />
                    <span>Disconnect & Remove</span>
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setIsManagingConnected(false);
                      }}
                      className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all cursor-pointer shadow-xs"
                    >
                      Update Credentials
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* ======================================================== */
              /* VIEW 2: AUTHENTICATION FLOW BY SERVICE METHOD            */
              /* ======================================================== */
              <div className="space-y-4">
                {/* ─── CASE A: OAUTH 2.0 REAL AUTHENTICATION ─── */}
                {configuringItem.authConfig?.method === "oauth" && (
                  <div className="space-y-3.5">
                    <div className="p-4 rounded-2xl bg-blue-50/50 border border-blue-100 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-800">
                          {configuringItem.authConfig.providerName || configuringItem.name} Official OAuth Authentication
                        </span>
                        <span className="text-[10px] font-semibold text-blue-700 bg-blue-100/70 px-2 py-0.5 rounded-full">
                          OAuth 2.0
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 leading-relaxed">
                        Connect your real {configuringItem.authConfig.providerName || configuringItem.name} account. Provide your account email and personal OAuth access token or service account key.
                      </p>
                      {configuringItem.authConfig.scopes && (
                        <div className="text-[10px] text-slate-500 space-y-1">
                          <span className="font-semibold text-slate-700">Requested Scopes:</span>
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {configuringItem.authConfig.scopes.map((sc) => (
                              <span key={sc} className="px-1.5 py-0.5 rounded bg-white border border-slate-200 font-mono text-[9.5px]">
                                {sc.split("/").pop()}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Real Account Email / Identity Input */}
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                        <span>Account Email / Identity <span className="text-rose-500">*</span></span>
                        <span className="text-[10.5px] text-slate-400">Your registered email address</span>
                      </label>
                      <input
                        type="email"
                        value={oauthIdentityInput}
                        onChange={(e) => setOauthIdentityInput(e.target.value)}
                        placeholder="e.g. user@yourdomain.com"
                        className="w-full px-3.5 py-2 text-xs bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-900/5 transition-all"
                      />
                    </div>

                    {/* Real OAuth Access Token / Key Input */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-slate-800">
                          OAuth Access Token / Bearer Key <span className="text-rose-500">*</span>
                        </label>
                        {configuringItem.authConfig?.keyUrl && (
                          <a
                            href={configuringItem.authConfig.keyUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            <span>Open {configuringItem.authConfig.providerName || configuringItem.name} Console</span>
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                      <div className="relative">
                        <input
                          type={showSecretPassword ? "text" : "password"}
                          value={secretKeyInput}
                          onChange={(e) => setSecretKeyInput(e.target.value)}
                          placeholder={configuringItem.authConfig?.keyPlaceholder || "Paste OAuth Access Token (ya29..., xoxb-..., etc.)"}
                          className="w-full pl-3.5 pr-10 py-2.5 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-900/5 transition-all"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecretPassword(!showSecretPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                        >
                          {showSecretPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      <p className="text-[10.5px] text-slate-400">
                        Credentials are encrypted in your local OS vault and passed to the MCP server securely.
                      </p>
                    </div>

                    {/* Advanced Authentication Accordion */}
                    <AdvancedAuthFields
                      show={showAdvancedAuth}
                      onToggle={() => setShowAdvancedAuth(!showAdvancedAuth)}
                      clientId={advancedClientId}
                      setClientId={setAdvancedClientId}
                      clientSecret={advancedClientSecret}
                      setClientSecret={setAdvancedClientSecret}
                      scopes={advancedScopes}
                      setScopes={setAdvancedScopes}
                      redirectUri={advancedRedirectUri}
                      setRedirectUri={setAdvancedRedirectUri}
                      serviceAccountJson={advancedServiceAccountJson}
                      setServiceAccountJson={setAdvancedServiceAccountJson}
                      endpointUrl={advancedEndpointUrl}
                      setEndpointUrl={setAdvancedEndpointUrl}
                      customHeaders={advancedCustomHeaders}
                      setCustomHeaders={setAdvancedCustomHeaders}
                    />

                    {/* Action Buttons */}
                    <div className="flex items-center justify-end gap-2.5 pt-2">
                      <button
                        type="button"
                        onClick={() => setConfiguringItemId(null)}
                        className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOAuthConnect()}
                        disabled={isAuthorizingOAuth || !oauthIdentityInput.trim() || (!secretKeyInput.trim() && !advancedServiceAccountJson.trim())}
                        className="px-5 py-2.5 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
                      >
                        <Check size={13} strokeWidth={2.5} />
                        <span>Authenticate & Connect</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── CASE B: MULTI-FIELD STRUCTURED CREDENTIALS ─── */}
                {configuringItem.authConfig?.method === "multi_field" && (
                  <div className="space-y-3">
                    {configuringItem.authConfig.fields?.map((field) => {
                      const isPwd = field.type === "password";
                      const showPwd = Boolean(showMultiFieldPassword[field.key]);

                      return (
                        <div key={field.key} className="space-y-1">
                          <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                            <span>
                              {field.label} {field.required && <span className="text-rose-500">*</span>}
                            </span>
                            {field.description && (
                              <span className="text-[10px] text-slate-400 font-normal">{field.description}</span>
                            )}
                          </label>

                          {field.type === "select" ? (
                            <select
                              value={multiFieldInputs[field.key] || field.defaultValue || ""}
                              onChange={(e) =>
                                setMultiFieldInputs((prev) => ({ ...prev, [field.key]: e.target.value }))
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-black focus:ring-2 focus:ring-black/5"
                            >
                              {field.options?.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div className="relative">
                              <input
                                type={isPwd ? (showPwd ? "text" : "password") : field.type}
                                value={multiFieldInputs[field.key] || ""}
                                onChange={(e) =>
                                  setMultiFieldInputs((prev) => ({ ...prev, [field.key]: e.target.value }))
                                }
                                placeholder={field.placeholder}
                                className={`w-full pl-3 py-2.5 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-black focus:ring-2 focus:ring-black/5 ${
                                  isPwd ? "pr-10" : "pr-3"
                                }`}
                              />
                              {isPwd && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowMultiFieldPassword((prev) => ({
                                      ...prev,
                                      [field.key]: !prev[field.key],
                                    }))
                                  }
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                                >
                                  {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                                        {/* Advanced Authentication Accordion */}
                    <AdvancedAuthFields
                      show={showAdvancedAuth}
                      onToggle={() => setShowAdvancedAuth(!showAdvancedAuth)}
                      clientId={advancedClientId}
                      setClientId={setAdvancedClientId}
                      clientSecret={advancedClientSecret}
                      setClientSecret={setAdvancedClientSecret}
                      scopes={advancedScopes}
                      setScopes={setAdvancedScopes}
                      redirectUri={advancedRedirectUri}
                      setRedirectUri={setAdvancedRedirectUri}
                      serviceAccountJson={advancedServiceAccountJson}
                      setServiceAccountJson={setAdvancedServiceAccountJson}
                      endpointUrl={advancedEndpointUrl}
                      setEndpointUrl={setAdvancedEndpointUrl}
                      customHeaders={advancedCustomHeaders}
                      setCustomHeaders={setAdvancedCustomHeaders}
                    />

<div className="flex items-center justify-end gap-2.5 pt-2">
                      <button
                        type="button"
                        onClick={() => setConfiguringItemId(null)}
                        className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveMultiFieldAndConnect}
                        disabled={busy}
                        className="px-5 py-2 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
                      >
                        <Check size={13} strokeWidth={2.5} />
                        <span>Save & Connect</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── CASE C: SINGLE API KEY / TOKEN ─── */}
                {configuringItem.authConfig?.method === "api_key" && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                        <span>{configuringItem.authConfig.keyLabel || "API Access Token"}</span>
                        <span className="text-[11px] font-normal text-emerald-600 flex items-center gap-1">
                          <Lock size={10} /> Local OS Keychain Vault
                        </span>
                      </label>
                      <div className="relative">
                        <input
                          type={showSecretPassword ? "text" : "password"}
                          autoFocus
                          value={secretKeyInput}
                          onChange={(e) => setSecretKeyInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveApiKeyAndConnect();
                          }}
                          placeholder={configuringItem.authConfig.keyPlaceholder || "Paste secret key..."}
                          className="w-full pl-3.5 pr-10 py-2.5 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-black focus:ring-2 focus:ring-black/5 transition-all"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecretPassword(!showSecretPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                        >
                          {showSecretPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Your key is encrypted on this machine and never transmitted to our servers.
                      </p>
                    </div>

                                        {/* Advanced Authentication Accordion */}
                    <AdvancedAuthFields
                      show={showAdvancedAuth}
                      onToggle={() => setShowAdvancedAuth(!showAdvancedAuth)}
                      clientId={advancedClientId}
                      setClientId={setAdvancedClientId}
                      clientSecret={advancedClientSecret}
                      setClientSecret={setAdvancedClientSecret}
                      scopes={advancedScopes}
                      setScopes={setAdvancedScopes}
                      redirectUri={advancedRedirectUri}
                      setRedirectUri={setAdvancedRedirectUri}
                      serviceAccountJson={advancedServiceAccountJson}
                      setServiceAccountJson={setAdvancedServiceAccountJson}
                      endpointUrl={advancedEndpointUrl}
                      setEndpointUrl={setAdvancedEndpointUrl}
                      customHeaders={advancedCustomHeaders}
                      setCustomHeaders={setAdvancedCustomHeaders}
                    />

<div className="flex items-center justify-end gap-2.5 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setConfiguringItemId(null);
                          setSecretKeyInput("");
                        }}
                        className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveApiKeyAndConnect}
                        disabled={busy || !secretKeyInput.trim()}
                        className="px-5 py-2 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all shadow-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                      >
                        <Check size={13} strokeWidth={2.5} />
                        <span>Authenticate & Connect</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── CASE D: LOCAL DAEMON (DOCKER) ─── */}
                {configuringItem.authConfig?.method === "local_daemon" && (
                  <div className="space-y-4">
                    <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2">
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                        <Laptop size={15} className="text-blue-600" />
                        <span>Local Daemon Verification</span>
                      </div>
                      <p className="text-[11px] text-slate-600 leading-relaxed">
                        Docker MCP does not require external API keys. It talks directly to your local Docker Desktop engine via local named pipes or socket.
                      </p>
                    </div>

                    <div className="flex items-center justify-end gap-2.5 pt-2">
                      <button
                        type="button"
                        onClick={() => setConfiguringItemId(null)}
                        className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 rounded-xl cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConnectLocalDaemon}
                        disabled={busy}
                        className="px-5 py-2 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all shadow-xs cursor-pointer flex items-center gap-1.5"
                      >
                        <Check size={13} strokeWidth={2.5} />
                        <span>Connect Docker Daemon</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── CASE E: LOCAL PATH (FILESYSTEM) ─── */}
                {configuringItem.authConfig?.method === "local_path" && (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-800 flex items-center justify-between">
                        <span>Allowed Root Directory</span>
                        <span className="text-[11px] text-slate-400">Sandboxed Access</span>
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={localPathInput}
                          onChange={(e) => setLocalPathInput(e.target.value)}
                          placeholder="C:/Workspace or /Users/work"
                          className="w-full pl-3.5 pr-3 py-2.5 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-black focus:ring-2 focus:ring-black/5"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2.5 pt-2">
                      <button
                        type="button"
                        onClick={() => setConfiguringItemId(null)}
                        className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 rounded-xl cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConnectLocalPath}
                        disabled={busy || !localPathInput.trim()}
                        className="px-5 py-2 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl transition-all shadow-xs cursor-pointer flex items-center gap-1.5"
                      >
                        <Check size={13} strokeWidth={2.5} />
                        <span>Mount Workspace Path</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── BOT TEMPLATES DRAWER MODAL ─── */}
      {showBotTemplatesModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-white rounded-3xl shadow-2xl border border-slate-200 p-6 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">🎱</span>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Pre-Configured Bot Stacks</h3>
                  <p className="text-xs text-slate-500">
                    Mount verified bundles of MCP tools directly into your active bot profile
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowBotTemplatesModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-full hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {BOT_TEMPLATES.map((tmpl) => (
                <div
                  key={tmpl.id}
                  className="p-4 rounded-2xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50/60 transition-all space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{tmpl.icon}</span>
                      <h4 className="text-sm font-bold text-slate-900">{tmpl.title}</h4>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleApplyTemplate(tmpl)}
                      disabled={busy}
                      className="text-xs font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs cursor-pointer active:scale-95 disabled:opacity-50"
                    >
                      Apply Stack
                    </button>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">{tmpl.description}</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {tmpl.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
