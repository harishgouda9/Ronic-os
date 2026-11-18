import { useMemo, useState } from "react";
import { Check, ExternalLink, Eye, EyeOff, Folder, KeyRound, Lock, RefreshCw, Server, ShieldCheck, Trash2 } from "lucide-react";
import { isTauri, pickPaths } from "../api";
import {
  findCatalogMcp,
  getMcpAuthVault,
  installMarketplaceItem,
  isItemConnected,
  isPlaceholderCredential,
  removeMarketplaceItem,
  type MarketplaceCatalogItem,
} from "../kernel/marketplaceCatalog";
import { verifyMcpCredentials } from "../kernel/mcpAuthVerify";
import { useRonic } from "../store";
import type { Step } from "../types";

export function McpConnectCard({ step }: { step: Step }) {
  const snap = useRonic((s) => s.snap);
  const run = useRonic((s) => s.run);
  const setToast = useRonic((s) => s.setToast);

  const payload = step.actionPayload as Record<string, unknown>;
  const reqId = String(payload.id ?? "").trim();
  const reqSlug = String(payload.catalogSlug ?? payload.slug ?? "").trim();
  const reqName = String(payload.name ?? "").trim() || "MCP Server";
  const reqTransport = String(payload.transport ?? "").trim();
  const reqCommand = String(payload.command ?? "").trim();
  const reqArgs = Array.isArray(payload.args) ? payload.args.map(String) : [];
  const reqUrl = String(payload.url ?? "").trim();
  const profileId = String(payload.profileId ?? snap?.activeProfileId ?? "").trim();

  const catalogItem: MarketplaceCatalogItem | undefined = useMemo(
    () => findCatalogMcp({ id: reqId, catalogSlug: reqSlug, name: reqName }),
    [reqId, reqSlug, reqName]
  );

  const [vaultTick, setVaultTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [identityInput, setIdentityInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [multiFields, setMultiFields] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const f of catalogItem?.authConfig?.fields ?? []) {
      if (f.defaultValue) defaults[f.key] = f.defaultValue;
    }
    return defaults;
  });
  const [showFieldPwd, setShowFieldPwd] = useState<Record<string, boolean>>({});
  const [localPathInput, setLocalPathInput] = useState("");
  const [customUrlInput, setCustomUrlInput] = useState(reqUrl);
  const [customCmdInput, setCustomCmdInput] = useState(reqCommand);

  const authVault = useMemo(() => {
    void vaultTick;
    return getMcpAuthVault();
  }, [vaultTick]);

  const installedServer = useMemo(() => {
    if (!snap) return undefined;
    const matchId = catalogItem?.id || reqId;
    return snap.mcpServers.find(
      (s) => s.id === matchId || s.name.toLowerCase() === (catalogItem?.name || reqName).toLowerCase()
    );
  }, [snap, catalogItem, reqId, reqName]);

  const connected = useMemo(() => {
    if (!snap) return false;
    if (catalogItem) return isItemConnected(catalogItem, snap, undefined, authVault);
    return Boolean(installedServer && installedServer.trust === "trusted");
  }, [snap, catalogItem, authVault, installedServer]);

  const authRecord = catalogItem ? authVault[catalogItem.id] : undefined;
  const authMethod = catalogItem
    ? catalogItem.authConfig?.method || (catalogItem.requiresAuth || catalogItem.requiresKey ? "api_key" : "none")
    : "custom";

  const isGoogle = Boolean(
    catalogItem && (catalogItem.slug.includes("google") || catalogItem.id === "mcp-gmail")
  );

  const title = catalogItem?.name || reqName;
  const description =
    catalogItem?.description ||
    (reqUrl ? `Remote MCP server (${reqUrl})` : reqCommand ? `Local MCP server (${reqCommand})` : "MCP server connection");

  const handleBrowseFolder = async () => {
    const picked = await pickPaths("folder");
    if (picked[0]) setLocalPathInput(picked[0]);
  };

  const handleCatalogConnect = async () => {
    if (!catalogItem) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setWorking(true);
    try {
      let msg = "";
      if (authMethod === "none") {
        msg = await installMarketplaceItem(catalogItem, profileId, run);
      } else if (authMethod === "oauth") {
        const identity = identityInput.trim();
        const token = secretInput.trim();
        const svcJson = serviceAccountJson.trim();
        if (!identity && !svcJson) {
          throw new Error(`Enter your ${catalogItem.authConfig?.providerName || catalogItem.name} account email or identity.`);
        }
        if (!token && !svcJson) {
          throw new Error(`Paste an OAuth access token${isGoogle ? " or service account JSON" : ""} to authenticate.`);
        }
        const advanced = svcJson ? { serviceAccountJson: svcJson } : undefined;
        const checked = await verifyMcpCredentials(
          catalogItem,
          { identity, secret: token || svcJson, advanced },
          run
        );
        msg = await installMarketplaceItem(catalogItem, profileId, run, {
          identity: checked.identity,
          secretKey: token || svcJson,
          advanced,
          verified: true,
        });
      } else if (authMethod === "api_key") {
        const key = secretInput.trim();
        if (!key) throw new Error(`Enter an API key or token for ${catalogItem.name}.`);
        const checked = await verifyMcpCredentials(catalogItem, { secret: key }, run);
        msg = await installMarketplaceItem(catalogItem, profileId, run, {
          secretKey: key,
          identity: checked.identity,
          verified: true,
        });
      } else if (authMethod === "multi_field") {
        const fields = catalogItem.authConfig?.fields ?? [];
        for (const f of fields) {
          if (f.required && !multiFields[f.key]?.trim()) {
            throw new Error(`Fill in required field: ${f.label}.`);
          }
        }
        const primarySecret =
          multiFields.accessToken ||
          multiFields.serviceKey ||
          multiFields.apiKey ||
          multiFields.authToken ||
          multiFields.keySecret ||
          multiFields.password ||
          multiFields.connectionUri ||
          multiFields.connectionUrl ||
          "";
        if (primarySecret && isPlaceholderCredential(primarySecret)) {
          throw new Error(`${catalogItem.name} needs a real credential.`);
        }
        const checked = await verifyMcpCredentials(
          catalogItem,
          { secret: primarySecret, config: multiFields },
          run
        );
        msg = await installMarketplaceItem(catalogItem, profileId, run, {
          identity: checked.identity,
          secretKey: primarySecret,
          config: multiFields,
          verified: true,
        });
      } else if (authMethod === "local_path") {
        const dir = localPathInput.trim();
        if (!dir) throw new Error("Choose or enter a folder path on this computer.");
        const checked = await verifyMcpCredentials(
          catalogItem,
          { identity: dir, config: { rootPath: dir } },
          run
        );
        msg = await installMarketplaceItem(catalogItem, profileId, run, {
          identity: checked.identity,
          config: { rootPath: dir },
          verified: true,
        });
      } else if (authMethod === "local_daemon") {
        const checked = await verifyMcpCredentials(catalogItem, {}, run);
        msg = await installMarketplaceItem(catalogItem, profileId, run, {
          identity: checked.identity,
          verified: true,
        });
      }
      setVaultTick((t) => t + 1);
      setEditing(false);
      setSecretInput("");
      setServiceAccountJson("");
      setSuccessMsg(msg || `${catalogItem.name} authenticated and connected.`);
      setToast(msg || `${catalogItem.name} connected.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleCustomConnect = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    const url = customUrlInput.trim();
    const cmd = customCmdInput.trim();
    const secret = secretInput.trim();
    const isRemote = /^https?:\/\//i.test(url) || reqTransport === "sse";
    const isLocalhost = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url);

    if (!url && !cmd) {
      setErrorMsg("Provide an HTTPS MCP endpoint URL or a local command.");
      return;
    }
    if (isRemote && !isLocalhost && (!secret || isPlaceholderCredential(secret))) {
      setErrorMsg(`Remote MCP server "${title}" requires a real API key or Bearer token.`);
      return;
    }

    setWorking(true);
    try {
      const res = await run("connect_mcp_server", {
        name: title,
        transport: url ? "sse" : reqTransport || "stdio",
        command: cmd || undefined,
        args: reqArgs.length ? reqArgs : undefined,
        url: url || undefined,
        secret: secret || undefined,
      });
      if (!res) {
        throw new Error(`Could not connect "${title}". Check the server details and try again.`);
      }
      setEditing(false);
      setSecretInput("");
      setSuccessMsg(res.toast || `${title} connected and saved to vault.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleDisconnect = async () => {
    if (!snap) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setWorking(true);
    try {
      if (catalogItem) {
        const msg = await removeMarketplaceItem(catalogItem, snap, run);
        setVaultTick((t) => t + 1);
        setToast(msg);
      } else if (installedServer) {
        await run("remove_mcp", { id: installedServer.id });
      }
      setEditing(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const showConnectedView = connected && !editing;

  return (
    <article className="my-2 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/95 p-4 shadow-xs space-y-3 text-slate-900 dark:text-slate-100">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div
            className={`mt-0.5 p-2 rounded-xl border shrink-0 ${
              showConnectedView
                ? "bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-400"
                : "bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400"
            }`}
          >
            {showConnectedView ? <ShieldCheck size={16} /> : <Server size={16} />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <strong className="text-sm font-bold truncate">{title}</strong>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                  showConnectedView
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                    : "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800"
                }`}
              >
                {showConnectedView ? "Authenticated & Connected" : "Authentication Required"}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{description}</p>
          </div>
        </div>
        {catalogItem?.authConfig?.keyUrl && !showConnectedView && (
          <a
            href={catalogItem.authConfig.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
          >
            <span>Get Token</span>
            <ExternalLink size={11} />
          </a>
        )}
      </div>

      {/* Connected State */}
      {showConnectedView ? (
        <div className="space-y-2.5">
          <div className="rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
              <Check size={13} />
              <span>
                Connected{authRecord?.accountIdentity ? ` as ${authRecord.accountIdentity}` : ""}
                {authRecord?.credentialMask ? ` (${authRecord.credentialMask})` : ""} · Ready for this bot
              </span>
            </div>
            <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
              <Lock size={10} /> OS Vault
            </span>
          </div>
          {successMsg && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{successMsg}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={working}
              onClick={() => setEditing(true)}
              className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1"
            >
              <RefreshCw size={11} />
              <span>Update Credentials</span>
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => void handleDisconnect()}
              className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-rose-200 dark:border-rose-800/70 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer flex items-center gap-1"
            >
              <Trash2 size={11} />
              <span>Disconnect</span>
            </button>
          </div>
        </div>
      ) : (
        /* Auth & Connect Form */
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (catalogItem ? handleCatalogConnect() : handleCustomConnect());
          }}
          className="space-y-3"
        >
          {/* OAUTH */}
          {authMethod === "oauth" && catalogItem && (
            <div className="space-y-2.5">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 block">
                  Account Email / Identity
                </label>
                <input
                  type="text"
                  value={identityInput}
                  onChange={(e) => setIdentityInput(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-between">
                  <span>{catalogItem.authConfig?.keyLabel || "OAuth Access Token / Bearer Key"}</span>
                  <span className="text-[10px] font-normal text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Lock size={10} /> Encrypted in Vault (never sent to LLM)
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={secretInput}
                    onChange={(e) => setSecretInput(e.target.value)}
                    placeholder={catalogItem.authConfig?.keyPlaceholder || "Paste OAuth access token or integration secret..."}
                    className="w-full pl-3 pr-9 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                    aria-label={showSecret ? "Hide token" : "Show token"}
                  >
                    {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
              {isGoogle && (
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 block">
                    Or Google Service Account JSON (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={serviceAccountJson}
                    onChange={(e) => setServiceAccountJson(e.target.value)}
                    placeholder='{"type":"service_account","client_email":"...","private_key":"..."}'
                    className="w-full px-3 py-2 text-[11px] font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500 resize-none"
                  />
                </div>
              )}
            </div>
          )}

          {/* API KEY */}
          {authMethod === "api_key" && catalogItem && (
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-between">
                <span>{catalogItem.authConfig?.keyLabel || "API Key / Secret Token"}</span>
                <span className="text-[10px] font-normal text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <Lock size={10} /> Encrypted in Vault (never sent to LLM)
                </span>
              </label>
              <div className="relative">
                <input
                  type={showSecret ? "text" : "password"}
                  value={secretInput}
                  onChange={(e) => setSecretInput(e.target.value)}
                  placeholder={catalogItem.authConfig?.keyPlaceholder || "Paste API key..."}
                  className="w-full pl-3 pr-9 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label={showSecret ? "Hide key" : "Show key"}
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          )}

          {/* MULTI FIELD */}
          {authMethod === "multi_field" && catalogItem && (
            <div className="space-y-2">
              {(catalogItem.authConfig?.fields ?? []).map((field) => {
                const isPwd = field.type === "password";
                const visible = Boolean(showFieldPwd[field.key]);
                return (
                  <div key={field.key} className="space-y-1">
                    <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 block">
                      {field.label} {field.required && <span className="text-rose-500">*</span>}
                    </label>
                    {field.type === "select" ? (
                      <select
                        value={multiFields[field.key] || field.defaultValue || ""}
                        onChange={(e) => setMultiFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                      >
                        {(field.options ?? []).map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="relative">
                        <input
                          type={isPwd ? (visible ? "text" : "password") : field.type}
                          value={multiFields[field.key] || ""}
                          onChange={(e) => setMultiFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          className={`w-full pl-3 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500 ${
                            isPwd ? "pr-9" : "pr-3"
                          }`}
                        />
                        {isPwd && (
                          <button
                            type="button"
                            onClick={() => setShowFieldPwd((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                            aria-label={visible ? "Hide value" : "Show value"}
                          >
                            {visible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* LOCAL PATH */}
          {authMethod === "local_path" && (
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 block">
                Allowed Local Directory
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={localPathInput}
                  onChange={(e) => setLocalPathInput(e.target.value)}
                  placeholder="C:\\Projects\\my-workspace"
                  className="flex-1 px-3 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                />
                {isTauri() && (
                  <button
                    type="button"
                    onClick={() => void handleBrowseFolder()}
                    className="px-3 py-2 text-xs font-semibold rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
                  >
                    <Folder size={13} />
                    <span>Browse</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* LOCAL DAEMON */}
          {authMethod === "local_daemon" && catalogItem && (
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Checks that {catalogItem.authConfig?.daemonName || catalogItem.name} is running on this computer before trusting and connecting the MCP server.
            </p>
          )}

          {/* CUSTOM MCP SERVER (not in catalog) */}
          {authMethod === "custom" && (
            <div className="space-y-2">
              {reqUrl || !reqCommand ? (
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 block">
                    MCP Endpoint URL
                  </label>
                  <input
                    type="url"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 block">
                    Local Command
                  </label>
                  <input
                    type="text"
                    value={customCmdInput}
                    onChange={(e) => setCustomCmdInput(e.target.value)}
                    placeholder="npx"
                    className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                  />
                </div>
              )}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-between">
                  <span>API Key / Bearer Token</span>
                  <span className="text-[10px] font-normal text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Lock size={10} /> Encrypted in Vault
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={secretInput}
                    onChange={(e) => setSecretInput(e.target.value)}
                    placeholder="Paste bearer token or API key..."
                    className="w-full pl-3 pr-9 py-2 text-xs font-mono rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                    aria-label={showSecret ? "Hide key" : "Show key"}
                  >
                    {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/70 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              {errorMsg}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {editing && (
              <button
                type="button"
                disabled={working}
                onClick={() => {
                  setEditing(false);
                  setErrorMsg(null);
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={working}
              className="px-4 py-2 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
            >
              <KeyRound size={12} />
              <span>
                {working
                  ? "Verifying & Connecting..."
                  : authMethod === "none"
                  ? "Connect MCP Server"
                  : authMethod === "local_daemon"
                  ? "Verify Daemon & Connect"
                  : authMethod === "local_path"
                  ? "Verify Folder & Connect"
                  : "Authenticate & Connect"}
              </span>
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
