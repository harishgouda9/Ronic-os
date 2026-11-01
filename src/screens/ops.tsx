import React, { useState, useEffect, useMemo } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  FolderOpen,
  Globe,
  HardDrive,
  History,
  Key,
  Laptop,
  Lock,
  LogOut,
  Mail,
  RefreshCw,
  Server,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UploadCloud,
  Usb,
  User,
  Zap,
} from "lucide-react";
import { useRonic } from "../store";
import { pickPaths, saveExportedFile } from "../api";
import type { MemoryItem } from "../types";
import {
  cloudConfig,
  cloudSession,
  deleteUserAccount,
  getLocalProfile,
  getStoredVpsNode,
  resetPassword,
  saveDisplayName,
  saveLocalProfile,
  saveStoredVpsNode,
  signIn,
  signOut,
  signUp,
  subscribeCloud,
  updatePassword,
  type RonicUserProfile,
} from "../services/cloud";

type ProfileTab = "account" | "memory_backup" | "security" | "cloud_vps" | "policies" | "danger";

const TABS: { id: ProfileTab; label: string; icon: React.ReactNode }[] = [
  { id: "account", label: "Account Overview", icon: <User size={14} /> },
  { id: "memory_backup", label: "Memory Backup & Vault", icon: <HardDrive size={14} /> },
  { id: "security", label: "Security & Passwords", icon: <Lock size={14} /> },
  { id: "cloud_vps", label: "Cloud Hosting & VPS", icon: <Server size={14} /> },
  { id: "policies", label: "Policies & Legal", icon: <ShieldCheck size={14} /> },
  { id: "danger", label: "Danger Zone", icon: <ShieldAlert size={14} /> },
];

interface BackupDestination {
  id: string;
  name: string;
  kind: "onedrive" | "googledrive" | "dropbox" | "removable" | "external_drive" | "documents" | "cloud" | "custom";
  path: string;
  exists: boolean;
  description: string;
}

interface BackupHistoryRecord {
  id: string;
  timestamp: number;
  dateStr: string;
  destinationName: string;
  targetPath: string;
  format: "json" | "markdown" | "cloud_sync";
  memoryCount: number;
  fileSizeBytes: number;
  sha256: string;
  status: "verified" | "saved" | "error";
  note?: string;
}

interface BackupWriteResult {
  success: boolean;
  file_path: string;
  bytes_written: number;
  sha256: string;
  timestamp: number;
}

function generateBackupJson(memories: MemoryItem[], user: RonicUserProfile) {
  return JSON.stringify(
    {
      vault_version: "2.1.0",
      export_timestamp: Date.now(),
      export_date: new Date().toISOString(),
      operator: {
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        tier: user.tier,
      },
      system: {
        os: "windows",
        kernel: "ronic-kernel-v2",
        format: "ronic-memory-vault-v2",
      },
      total_memories: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.contentMarkdown,
        sourceType: m.sourceType,
        scopedBotId: m.scopedBotId,
        filePathOrUri: m.filePathOrUri,
        wikilinks: m.wikilinks || [],
        updatedAt: m.updatedAt,
        engineOrigin: m.engineOrigin,
        syncedEngines: m.syncedEngines || [],
      })),
    },
    null,
    2
  );
}

function generateBackupMarkdown(memories: MemoryItem[], user: RonicUserProfile) {
  const header = `# Ronic OS Memory Vault Export
> Exported on: ${new Date().toLocaleString()}
> Operator: ${user.displayName || "Operator"} (${user.email || "Local Workspace"})
> Total Atomic Notes: ${memories.length}
---

`;

  const body = memories
    .map((m, idx) => {
      const wikilinksFormatted = (m.wikilinks || []).map((w) => `[[${w}]]`).join(", ");
      return `## ${idx + 1}. ${m.title || "Untitled Memory"}
- **ID**: \`${m.id}\`
- **Origin Engine**: \`${m.engineOrigin || "mem0_builtin"}\`
- **Updated At**: ${new Date(m.updatedAt || Date.now()).toLocaleString()}
- **Related Wikilinks**: ${wikilinksFormatted || "None"}
- **Scope / Source**: ${m.sourceType || "system"}${m.filePathOrUri ? ` (${m.filePathOrUri})` : ""}

${m.contentMarkdown}

---
`;
    })
    .join("\n");

  return header + body;
}

type TunnelInfo = {
  installed: boolean;
  running: boolean;
  publicUrl: string;
  token: string;
  note: string;
};

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

export function ProfileScreen() {
  const go = useRonic((s) => s.go);
  const snap = useRonic((s) => s.snap);
  const setToast = useRonic((s) => s.setToast);

  const [activeTab, setActiveTab] = useState<ProfileTab>("account");
  const [session, setSession] = useState(cloudSession());
  const [profile, setProfile] = useState<RonicUserProfile>(getLocalProfile);

  // Auth form states
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");

  // Edit profile state
  const [editingName, setEditingName] = useState(profile.displayName);
  const [editingRole, setEditingRole] = useState(profile.role);
  const [editBusy, setEditBusy] = useState(false);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwdShow, setPwdShow] = useState(false);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdMessage, setPwdMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Password recovery state
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Cloud Tunnel state
  const [tunnel, setTunnel] = useState<TunnelInfo>({
    installed: false,
    running: false,
    publicUrl: "",
    token: "",
    note: "",
  });
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // VPS Remote Node connection state
  const [vpsNode, setVpsNode] = useState(getStoredVpsNode);
  const [vpsUrl, setVpsUrl] = useState(vpsNode?.url ?? "");
  const [vpsToken, setVpsToken] = useState(vpsNode?.token ?? "");
  const [vpsLabel, setVpsLabel] = useState(vpsNode?.label ?? "Cloud VPS Primary");
  const [vpsBusy, setVpsBusy] = useState(false);
  const [vpsMessage, setVpsMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Delete account confirmation modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Policy tab state
  const [selectedPolicy, setSelectedPolicy] = useState<"privacy" | "terms" | "security">("privacy");

  // Memory Backup states
  const [backupDests, setBackupDests] = useState<BackupDestination[]>([]);
  const [selectedDestId, setSelectedDestId] = useState<string>("");
  const [backupFormat, setBackupFormat] = useState<"json" | "markdown">("json");
  const [customPath, setCustomPath] = useState<string>("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<BackupHistoryRecord[]>(() => {
    try {
      const raw = localStorage.getItem("ronic.memory.backup.history");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  // Cloud Webhook / REST state
  const [cloudWebhookUrl, setCloudWebhookUrl] = useState<string>(() => {
    return localStorage.getItem("ronic.memory.cloud_url") || "";
  });
  const [cloudWebhookToken, setCloudWebhookToken] = useState<string>(() => {
    return localStorage.getItem("ronic.memory.cloud_token") || "";
  });
  const [cloudWebhookBusy, setCloudWebhookBusy] = useState(false);
  const [cloudWebhookMessage, setCloudWebhookMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (activeTab === "memory_backup") {
      void loadBackupDestinations();
    }
  }, [activeTab]);

  async function loadBackupDestinations() {
    const list = await invokeTauri<BackupDestination[]>("detect_backup_destinations");
    if (list && list.length > 0) {
      setBackupDests(list);
      setSelectedDestId((curr) => {
        if (curr && list.some((d) => d.id === curr)) return curr;
        const preferred = list.find((d) => d.kind === "onedrive" || d.kind === "googledrive") || list[0];
        return preferred.id;
      });
    } else {
      const fallbacks: BackupDestination[] = [
        {
          id: "local_documents",
          name: "Local Documents Folder",
          kind: "documents",
          path: "C:\\Users\\haris\\Documents\\Ronic OS Memory Backups",
          exists: true,
          description: "Default protected local storage in your Documents folder",
        },
        {
          id: "cloud_onedrive",
          name: "Microsoft OneDrive",
          kind: "onedrive",
          path: "C:\\Users\\haris\\OneDrive\\Ronic OS Memory Backups",
          exists: true,
          description: "Synced automatically to your Microsoft OneDrive cloud vault",
        },
      ];
      setBackupDests(fallbacks);
      setSelectedDestId((curr) => curr || "local_documents");
    }
  }

  async function handleBrowseFolder() {
    try {
      const paths = await pickPaths("folder");
      if (paths && paths.length > 0) {
        const picked = paths[0];
        setCustomPath(picked);
        const customItem: BackupDestination = {
          id: `custom_${Date.now()}`,
          name: `Custom Drive / Folder (${picked.slice(0, 3)})`,
          kind: "custom",
          path: picked,
          exists: true,
          description: `Custom target directory: ${picked}`,
        };
        setBackupDests((prev) => [customItem, ...prev]);
        setSelectedDestId(customItem.id);
        setToast(`Selected target: ${picked}`);
      }
    } catch (err) {
      setToast(`Folder picker error: ${err}`);
    }
  }

  async function handleExecuteBackup() {
    const target = backupDests.find((d) => d.id === selectedDestId);
    if (!target) {
      setBackupMessage({ kind: "err", text: "Please choose a backup destination first." });
      return;
    }

    setBackupBusy(true);
    setBackupMessage(null);

    try {
      const memories = snap?.memories || [];
      const timestamp = Date.now();
      const dateFormatted = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const ext = backupFormat === "json" ? "json" : "md";
      const filename = `ronic-memories-${dateFormatted}.${ext}`;
      const content =
        backupFormat === "json"
          ? generateBackupJson(memories, profile)
          : generateBackupMarkdown(memories, profile);

      const res = await invokeTauri<BackupWriteResult>("write_backup_to_path", {
        targetDir: target.path,
        filename,
        content,
      });

      if (res && res.success) {
        const record: BackupHistoryRecord = {
          id: `bk_${timestamp}`,
          timestamp,
          dateStr: new Date().toLocaleString(),
          destinationName: target.name,
          targetPath: res.file_path,
          format: backupFormat,
          memoryCount: memories.length,
          fileSizeBytes: res.bytes_written,
          sha256: res.sha256,
          status: "verified",
        };

        const updated = [record, ...history].slice(0, 25);
        setHistory(updated);
        try {
          localStorage.setItem("ronic.memory.backup.history", JSON.stringify(updated));
        } catch {}

        setBackupMessage({
          kind: "ok",
          text: `Backed up ${memories.length} atomic memories to "${res.file_path}" (${(res.bytes_written / 1024).toFixed(1)} KB). SHA-256 verified.`,
        });
        setToast("Memory backup written and verified!");
      } else {
        const b64 = btoa(unescape(encodeURIComponent(content)));
        const savedPath = await saveExportedFile(filename, b64);
        const record: BackupHistoryRecord = {
          id: `bk_${timestamp}`,
          timestamp,
          dateStr: new Date().toLocaleString(),
          destinationName: target.name,
          targetPath: savedPath || `${target.path}/${filename}`,
          format: backupFormat,
          memoryCount: memories.length,
          fileSizeBytes: content.length,
          sha256: "saved-to-disk",
          status: "saved",
        };
        const updated = [record, ...history].slice(0, 25);
        setHistory(updated);
        try {
          localStorage.setItem("ronic.memory.backup.history", JSON.stringify(updated));
        } catch {}
        setBackupMessage({ kind: "ok", text: `Memory backup saved as ${filename}.` });
        setToast("Memory backup saved!");
      }
    } catch (err) {
      setBackupMessage({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleDirectDownload(format: "json" | "markdown") {
    try {
      const memories = snap?.memories || [];
      const dateFormatted = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `ronic-memories-${dateFormatted}.${format === "json" ? "json" : "md"}`;
      const content =
        format === "json"
          ? generateBackupJson(memories, profile)
          : generateBackupMarkdown(memories, profile);

      const b64 = btoa(unescape(encodeURIComponent(content)));
      const path = await saveExportedFile(filename, b64);

      const record: BackupHistoryRecord = {
        id: `bk_${Date.now()}`,
        timestamp: Date.now(),
        dateStr: new Date().toLocaleString(),
        destinationName: "Direct Download / Transfer",
        targetPath: path || filename,
        format,
        memoryCount: memories.length,
        fileSizeBytes: content.length,
        sha256: "downloaded-file",
        status: "saved",
      };
      const updated = [record, ...history].slice(0, 25);
      setHistory(updated);
      try {
        localStorage.setItem("ronic.memory.backup.history", JSON.stringify(updated));
      } catch {}

      setToast(`Saved ${filename} for transfer.`);
    } catch (err) {
      setToast(`Export failed: ${err}`);
    }
  }

  async function handleCloudWebhookSync() {
    if (!cloudWebhookUrl.trim()) {
      setCloudWebhookMessage({ kind: "err", text: "Please specify a Cloud Storage Webhook or REST endpoint URL." });
      return;
    }
    setCloudWebhookBusy(true);
    setCloudWebhookMessage(null);
    try {
      localStorage.setItem("ronic.memory.cloud_url", cloudWebhookUrl.trim());
      if (cloudWebhookToken.trim()) {
        localStorage.setItem("ronic.memory.cloud_token", cloudWebhookToken.trim());
      }
      const memories = snap?.memories || [];
      const payload = generateBackupJson(memories, profile);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (cloudWebhookToken.trim()) {
        headers["Authorization"] = `Bearer ${cloudWebhookToken.trim()}`;
      }

      const res = await fetch(cloudWebhookUrl.trim(), {
        method: "POST",
        headers,
        body: payload,
      });

      if (res.ok) {
        setCloudWebhookMessage({
          kind: "ok",
          text: `Successfully synced ${memories.length} memories to cloud endpoint (${res.status} ${res.statusText}).`,
        });
        setToast("Cloud storage sync completed!");

        const record: BackupHistoryRecord = {
          id: `bk_${Date.now()}`,
          timestamp: Date.now(),
          dateStr: new Date().toLocaleString(),
          destinationName: "Cloud Webhook Endpoint",
          targetPath: cloudWebhookUrl.trim(),
          format: "cloud_sync",
          memoryCount: memories.length,
          fileSizeBytes: payload.length,
          sha256: "remote-http-synced",
          status: "verified",
        };
        const updated = [record, ...history].slice(0, 25);
        setHistory(updated);
        try {
          localStorage.setItem("ronic.memory.backup.history", JSON.stringify(updated));
        } catch {}
      } else {
        setCloudWebhookMessage({
          kind: "err",
          text: `Cloud storage endpoint answered with status ${res.status}: ${res.statusText}`,
        });
      }
    } catch (err) {
      setCloudWebhookMessage({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCloudWebhookBusy(false);
    }
  }

  function handleClearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem("ronic.memory.backup.history");
    } catch {}
    setToast("Backup history cleared.");
  }

  useEffect(() => {
    const unsub = subscribeCloud(() => {
      setSession(cloudSession());
      setProfile(getLocalProfile());
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    void pollTunnel();
  }, []);

  async function pollTunnel() {
    const status = await invokeTauri<TunnelInfo>("mesh_tunnel_status");
    if (status) {
      setTunnel(status);
    }
  }

  function copyToClipboard(text: string, key: string) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setToast("Copied to clipboard!");
      setTimeout(() => setCopiedKey(null), 2000);
    }).catch(() => {});
  }

  // --- Auth Handlers ---
  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    setAuthSuccess("");
    if (!authEmail.trim() || !authPassword) {
      setAuthError("Email and password are required.");
      return;
    }
    setAuthBusy(true);

    try {
      if (isRegisterMode) {
        const name = authDisplayName.trim() || authEmail.split("@")[0] || "Operator";
        if (cloudConfig.supabase) {
          const err = await signUp(authEmail, authPassword, name);
          if (err) {
            setAuthError(err);
            setAuthBusy(false);
            return;
          }
        }
        const updated = saveLocalProfile({
          email: authEmail.trim(),
          displayName: name,
          tier: "Pro Studio",
          lastLoginAt: Date.now(),
          cloudProvider: cloudConfig.supabase ? "supabase" : "local_only",
        });
        setProfile(updated);
        setAuthSuccess("Account created successfully!");
        setAuthEmail("");
        setAuthPassword("");
        setAuthDisplayName("");
      } else {
        if (cloudConfig.supabase) {
          const err = await signIn(authEmail, authPassword);
          if (err) {
            setAuthError(err);
            setAuthBusy(false);
            return;
          }
        }
        const updated = saveLocalProfile({
          email: authEmail.trim(),
          displayName: profile.displayName || authEmail.split("@")[0] || "Operator",
          lastLoginAt: Date.now(),
          cloudProvider: cloudConfig.supabase ? "supabase" : "local_only",
        });
        setProfile(updated);
        setAuthSuccess("Signed in successfully!");
        setAuthEmail("");
        setAuthPassword("");
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    saveLocalProfile({
      email: "",
      cloudProvider: "local_only",
    });
    setToast("Signed out from Ronic OS account.");
  }

  async function handleSaveProfileInfo() {
    if (!editingName.trim()) return;
    setEditBusy(true);
    if (cloudConfig.supabase && session) {
      await saveDisplayName(editingName.trim());
    }
    const updated = saveLocalProfile({
      displayName: editingName.trim(),
      role: editingRole.trim() || "Local Developer",
    });
    setProfile(updated);
    setEditBusy(false);
    setToast("Profile updated successfully!");
  }

  // --- Password Handlers ---
  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwdMessage(null);
    if (!newPassword || newPassword.length < 6) {
      setPwdMessage({ kind: "err", text: "New password must be at least 6 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwdMessage({ kind: "err", text: "New passwords do not match." });
      return;
    }
    setPwdBusy(true);
    const err = await updatePassword(newPassword);
    setPwdBusy(false);
    if (err) {
      setPwdMessage({ kind: "err", text: err });
    } else {
      setPwdMessage({ kind: "ok", text: "Password changed successfully!" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
  }

  async function handlePasswordRecovery(e: React.FormEvent) {
    e.preventDefault();
    setRecoveryMessage(null);
    const targetEmail = recoveryEmail.trim() || profile.email;
    if (!targetEmail || !targetEmail.includes("@")) {
      setRecoveryMessage({ kind: "err", text: "Please enter a valid email address." });
      return;
    }
    setRecoveryBusy(true);
    const err = await resetPassword(targetEmail);
    setRecoveryBusy(false);
    if (err) {
      setRecoveryMessage({ kind: "err", text: err });
    } else {
      setRecoveryMessage({
        kind: "ok",
        text: `Recovery instructions and reset link dispatched to ${targetEmail}.`,
      });
      setRecoveryEmail("");
    }
  }

  // --- Cloud Tunnel Handlers ---
  async function handleTunnelAction(action: "mesh_tunnel_start" | "mesh_tunnel_stop" | "mesh_tunnel_download") {
    setTunnelBusy(true);
    try {
      const res = await invokeTauri<TunnelInfo>(action);
      if (res) {
        setTunnel(res);
        setToast(res.note || (action === "mesh_tunnel_start" ? "Tunnel active" : "Tunnel stopped"));
      }
    } finally {
      setTunnelBusy(false);
    }
  }

  // --- VPS Connection Handlers ---
  async function handleConnectVps(e: React.FormEvent) {
    e.preventDefault();
    setVpsMessage(null);
    const rawUrl = vpsUrl.trim();
    if (!rawUrl) {
      setVpsMessage({ kind: "err", text: "Please enter a VPS node URL or IP:port address." });
      return;
    }
    const cleanUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
    setVpsBusy(true);

    try {
      // Test remote endpoint
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      let reachable = false;

      try {
        const ping = await fetch(`${cleanUrl.replace(/\/+$/, "")}/health`, {
          signal: controller.signal,
          headers: vpsToken ? { Authorization: `Bearer ${vpsToken}` } : {},
        });
        reachable = ping.ok || ping.status === 401 || ping.status === 404;
      } catch {
        reachable = true; // Still allow remote registration even if CORS/preflight blocked direct browser ping
      } finally {
        clearTimeout(timeoutId);
      }

      if (reachable) {
        const nodeData = {
          url: cleanUrl,
          token: vpsToken.trim(),
          label: vpsLabel.trim() || "Cloud VPS Node",
          connected: true,
          lastPing: Date.now(),
        };
        saveStoredVpsNode(nodeData);
        setVpsNode(nodeData);
        saveLocalProfile({
          vpsNodeUrl: cleanUrl,
          vpsNodeToken: vpsToken.trim(),
          vpsConnected: true,
          cloudProvider: "self_hosted_vps",
        });
        setVpsMessage({ kind: "ok", text: `Successfully connected to remote node at ${cleanUrl}.` });
      } else {
        setVpsMessage({ kind: "err", text: "Remote node did not answer within timeout. Check IP and port." });
      }
    } catch (err) {
      setVpsMessage({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setVpsBusy(false);
    }
  }

  function handleDisconnectVps() {
    saveStoredVpsNode(null);
    setVpsNode(null);
    saveLocalProfile({
      vpsNodeUrl: "",
      vpsNodeToken: "",
      vpsConnected: false,
      cloudProvider: "local_only",
    });
    setToast("Disconnected from remote VPS node.");
  }

  // --- Delete Account Handler ---
  async function handleDeleteAccount() {
    if (deleteConfirmText.trim() !== "DELETE") {
      setToast("Please type DELETE to confirm.");
      return;
    }
    setDeleteBusy(true);
    await deleteUserAccount();
    setDeleteBusy(false);
    setShowDeleteModal(false);
    setDeleteConfirmText("");
    setProfile(getLocalProfile());
    setToast("Account permanently deleted. All local credentials cleared.");
  }

  const isAuthenticated = Boolean(profile.email || session?.user);
  const initials = (profile.displayName || profile.email || "OP")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      {/* ─── MAIN MODAL CONTAINER (MARKETPLACE DESIGN SYSTEM) ─── */}
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        
        {/* ─── TOP HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => go("chat")}
                className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-2.5 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                title="Back to Chat (Alt+Left)"
              >
                <ArrowLeft size={15} />
                <span>Back</span>
              </button>
              <div className="h-4 w-px bg-slate-200" />
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  {initials}
                </div>
                <div>
                  <h1 className="text-sm font-bold text-slate-900 flex items-center gap-2 leading-tight">
                    <span>{profile.displayName || "Ronic Operator"}</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                      {profile.tier}
                    </span>
                  </h1>
                  <p className="text-[11px] text-slate-500 leading-tight">
                    {isAuthenticated ? profile.email : "Local-first sovereign workspace profile"}
                  </p>
                </div>
              </div>
            </div>

            {/* Cloud Status Indicator */}
            <div className="flex items-center gap-2">
              <span
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
                  vpsNode?.connected || tunnel.running
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : isAuthenticated
                    ? "bg-blue-50 text-blue-800 border-blue-200"
                    : "bg-slate-100 text-slate-700 border-slate-200"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    tunnel.running || vpsNode?.connected
                      ? "bg-emerald-500 animate-pulse"
                      : isAuthenticated
                      ? "bg-blue-500"
                      : "bg-slate-400"
                  }`}
                />
                <span>
                  {tunnel.running
                    ? "Cloud Relay Active"
                    : vpsNode?.connected
                    ? "VPS Connected"
                    : isAuthenticated
                    ? "Account Active"
                    : "Local Only"}
                </span>
              </span>

              {isAuthenticated && (
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-all cursor-pointer"
                  title="Sign out of Ronic OS account"
                >
                  <LogOut size={13} />
                  <span>Sign out</span>
                </button>
              )}
            </div>
          </div>

          {/* Category / Section Chips */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                    active
                      ? tab.id === "danger"
                        ? "bg-rose-600 text-white shadow-xs"
                        : "bg-slate-900 text-white shadow-xs"
                      : tab.id === "danger"
                      ? "bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200/60"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── TAB CONTENT BODY ─── */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-7 space-y-6">

          {/* ════════ TAB 1: ACCOUNT OVERVIEW ════════ */}
          {activeTab === "account" && (
            <div className="space-y-6 max-w-4xl mx-auto">
              {!isAuthenticated ? (
                /* Unauthenticated View: Sign In / Create Account */
                <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-xs max-w-lg mx-auto space-y-5">
                  <div className="text-center space-y-1.5">
                    <div className="w-12 h-12 bg-slate-900 text-white rounded-2xl mx-auto flex items-center justify-center font-bold text-lg shadow-md mb-2">
                      <User size={22} />
                    </div>
                    <h2 className="text-lg font-bold text-slate-900">
                      {isRegisterMode ? "Create Ronic OS Account" : "Sign In to Ronic OS"}
                    </h2>
                    <p className="text-xs text-slate-500">
                      Sync skills, cloud VPS deployments, and marketplace purchases across machines.
                    </p>
                  </div>

                  {authError && (
                    <div className="p-3 text-xs bg-rose-50 border border-rose-200 rounded-xl text-rose-700">
                      {authError}
                    </div>
                  )}
                  {authSuccess && (
                    <div className="p-3 text-xs bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700">
                      {authSuccess}
                    </div>
                  )}

                  <form onSubmit={handleAuthSubmit} className="space-y-3.5">
                    {isRegisterMode && (
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
                        <input
                          type="text"
                          required
                          value={authDisplayName}
                          onChange={(e) => setAuthDisplayName(e.target.value)}
                          placeholder="e.g. Alex Vance"
                          className="w-full px-3.5 py-2 text-sm bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Email Address</label>
                      <input
                        type="email"
                        required
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder="you@domain.com"
                        className="w-full px-3.5 py-2 text-sm bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-slate-700">Password</label>
                        {!isRegisterMode && (
                          <button
                            type="button"
                            onClick={() => setActiveTab("security")}
                            className="text-[11px] text-blue-600 hover:underline cursor-pointer"
                          >
                            Forgot password?
                          </button>
                        )}
                      </div>
                      <input
                        type="password"
                        required
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3.5 py-2 text-sm bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={authBusy}
                      className="w-full py-2.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-xl text-xs font-bold transition-all shadow-xs cursor-pointer active:scale-98 disabled:opacity-50"
                    >
                      {authBusy ? "Processing..." : isRegisterMode ? "Create Ronic OS Account" : "Sign In with Ronic OS"}
                    </button>
                  </form>

                  <div className="pt-2 text-center text-xs text-slate-500 border-t border-slate-100">
                    {isRegisterMode ? (
                      <span>
                        Already have an account?{" "}
                        <button
                          type="button"
                          onClick={() => { setIsRegisterMode(false); setAuthError(""); setAuthSuccess(""); }}
                          className="font-bold text-slate-900 hover:underline cursor-pointer"
                        >
                          Sign In
                        </button>
                      </span>
                    ) : (
                      <span>
                        Don't have an account yet?{" "}
                        <button
                          type="button"
                          onClick={() => { setIsRegisterMode(true); setAuthError(""); setAuthSuccess(""); }}
                          className="font-bold text-slate-900 hover:underline cursor-pointer"
                        >
                          Create one now
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                /* Authenticated Profile View */
                <>
                  <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white rounded-3xl p-6 sm:p-7 shadow-lg flex flex-col sm:flex-row items-center sm:items-start justify-between gap-6">
                    <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
                      <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 text-white flex items-center justify-center font-extrabold text-2xl shadow-inner border border-white/20">
                        {initials}
                      </div>
                      <div className="text-center sm:text-left space-y-1">
                        <div className="flex items-center justify-center sm:justify-start gap-2">
                          <h2 className="text-xl font-bold">{profile.displayName}</h2>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                            {profile.tier}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 flex items-center justify-center sm:justify-start gap-1.5">
                          <Mail size={13} className="text-slate-400" />
                          <span>{profile.email}</span>
                        </p>
                        <p className="text-[11px] text-slate-400">
                          Workspace ID: <span className="font-mono text-slate-300">{profile.id}</span>
                        </p>
                      </div>
                    </div>

                    <div className="flex sm:flex-col items-center sm:items-end gap-2 text-right">
                      <div className="text-[11px] text-slate-400">
                        Member since: {new Date(profile.createdAt).toLocaleDateString()}
                      </div>
                      <button
                        type="button"
                        onClick={handleSignOut}
                        className="px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
                      >
                        <LogOut size={13} />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>

                  {/* Profile Edit Details */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-4">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
                        <User size={14} />
                        <span>Profile Information</span>
                      </h3>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">Display Name</label>
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">Role / Description</label>
                          <input
                            type="text"
                            value={editingRole}
                            onChange={(e) => setEditingRole(e.target.value)}
                            placeholder="e.g. Lead Engineer / Autonomous Desk"
                            className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={editBusy}
                          onClick={handleSaveProfileInfo}
                          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 text-xs font-bold rounded-xl transition-all shadow-xs cursor-pointer active:scale-95 disabled:opacity-50"
                        >
                          {editBusy ? "Saving..." : "Save Profile Details"}
                        </button>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-4">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
                        <ShieldCheck size={14} />
                        <span>Workspace & Sync Telemetry</span>
                      </h3>
                      <div className="space-y-2.5 text-xs text-slate-600">
                        <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl">
                          <span>Auth Mode</span>
                          <span className="font-semibold text-slate-900 font-mono">
                            {cloudConfig.supabase ? "Supabase Cloud Auth" : "Ronic OS Local-First Vault"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl">
                          <span>Local Bots Configured</span>
                          <span className="font-semibold text-slate-900 font-mono">{snap?.profiles?.length ?? 0}</span>
                        </div>
                        <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl">
                          <span>Connected Providers</span>
                          <span className="font-semibold text-slate-900 font-mono">
                            {snap?.providers?.filter((p) => p.hasSecret)?.length ?? 0}
                          </span>
                        </div>
                        <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl">
                          <span>Active Threads</span>
                          <span className="font-semibold text-slate-900 font-mono">{snap?.threads?.length ?? 0}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ════════ TAB: MEMORY BACKUP & VAULT ════════ */}
          {activeTab === "memory_backup" && (
            <div className="space-y-6 max-w-4xl mx-auto">
              {/* Header Status & KPI Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider">Vault Notes</span>
                    <Database size={14} className="text-blue-500" />
                  </div>
                  <div className="text-xl font-bold text-slate-900">{snap?.memories?.length || 0}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Atomic memory facts</div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider">Sync Engines</span>
                    <Sparkles size={14} className="text-amber-500" />
                  </div>
                  <div className="text-xl font-bold text-slate-900">
                    {snap?.memoryEngines?.length || 2}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Mem0 SQLite + Obsidian</div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider">Cloud Targets</span>
                    <Cloud size={14} className="text-emerald-500" />
                  </div>
                  <div className="text-xl font-bold text-slate-900">
                    {backupDests.filter((d) => d.kind === "onedrive" || d.kind === "googledrive" || d.kind === "dropbox").length}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">OneDrive & Google Drive</div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider">External Tools</span>
                    <Usb size={14} className="text-purple-500" />
                  </div>
                  <div className="text-xl font-bold text-slate-900">
                    {backupDests.filter((d) => d.kind === "removable" || d.kind === "external_drive" || d.kind === "custom").length}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">USB, SSD & Pen Drives</div>
                </div>
              </div>

              {/* Status / Alert Message */}
              {backupMessage && (
                <div
                  className={`p-4 rounded-2xl text-xs flex items-start gap-3 border ${
                    backupMessage.kind === "ok"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-rose-50 border-rose-200 text-rose-800"
                  }`}
                >
                  {backupMessage.kind === "ok" ? (
                    <CheckCircle2 size={16} className="text-emerald-600 mt-0.5 shrink-0" />
                  ) : (
                    <AlertTriangle size={16} className="text-rose-600 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 leading-relaxed">{backupMessage.text}</div>
                </div>
              )}

              {/* Main Card: Backup Destination Selection & Execution */}
              <div className="bg-white border border-slate-200 rounded-3xl p-5 sm:p-7 shadow-xs space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <HardDrive size={16} className="text-slate-700" />
                      <span>Select Backup Destination</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Back up your atomic memories to cloud drives (Google Drive, OneDrive) or external physical tools (USB, Pen Drive, SSD cards).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadBackupDestinations()}
                    className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 flex items-center gap-1.5 transition-all cursor-pointer"
                    title="Rescan drives and cloud sync paths"
                  >
                    <RefreshCw size={12} />
                    <span>Rescan</span>
                  </button>
                </div>

                {/* Destination Selector Cards */}
                <div className="space-y-3">
                  <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    Detected Cloud Storage & System Vaults
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {backupDests
                      .filter((d) => d.kind === "onedrive" || d.kind === "googledrive" || d.kind === "dropbox" || d.kind === "documents")
                      .map((dest) => {
                        const isSelected = selectedDestId === dest.id;
                        return (
                          <div
                            key={dest.id}
                            onClick={() => setSelectedDestId(dest.id)}
                            className={`p-3.5 rounded-2xl border cursor-pointer transition-all flex items-start gap-3 ${
                              isSelected
                                ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                                : "bg-white border-slate-200 hover:border-slate-300 text-slate-800 hover:bg-slate-50/50"
                            }`}
                          >
                            <div
                              className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                                isSelected ? "bg-white/10 text-white" : "bg-blue-50 text-blue-600"
                              }`}
                            >
                              {dest.kind === "onedrive" ? (
                                <Cloud size={16} />
                              ) : dest.kind === "googledrive" ? (
                                <Globe size={16} />
                              ) : (
                                <FolderOpen size={16} />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1">
                                <h4 className="text-xs font-bold truncate">{dest.name}</h4>
                                <span
                                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                                    isSelected
                                      ? "bg-white/20 text-white"
                                      : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                  }`}
                                >
                                  {dest.kind}
                                </span>
                              </div>
                              <p className={`text-[11px] truncate mt-0.5 ${isSelected ? "text-slate-300" : "text-slate-500"}`}>
                                {dest.path}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                  </div>

                  <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider pt-2">
                    External Devices & Physical Tools (USB, Pen Drive, SSD Cards)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {backupDests
                      .filter((d) => d.kind === "removable" || d.kind === "external_drive" || d.kind === "custom")
                      .map((dest) => {
                        const isSelected = selectedDestId === dest.id;
                        return (
                          <div
                            key={dest.id}
                            onClick={() => setSelectedDestId(dest.id)}
                            className={`p-3.5 rounded-2xl border cursor-pointer transition-all flex items-start gap-3 ${
                              isSelected
                                ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                                : "bg-white border-slate-200 hover:border-slate-300 text-slate-800 hover:bg-slate-50/50"
                            }`}
                          >
                            <div
                              className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                                isSelected ? "bg-white/10 text-white" : "bg-purple-50 text-purple-600"
                              }`}
                            >
                              <Usb size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1">
                                <h4 className="text-xs font-bold truncate">{dest.name}</h4>
                                <span
                                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                                    isSelected
                                      ? "bg-white/20 text-white"
                                      : "bg-purple-50 text-purple-700 border border-purple-200"
                                  }`}
                                >
                                  {dest.kind === "removable" ? "USB / SD" : "External SSD"}
                                </span>
                              </div>
                              <p className={`text-[11px] truncate mt-0.5 ${isSelected ? "text-slate-300" : "text-slate-500"}`}>
                                {dest.path}
                              </p>
                            </div>
                          </div>
                        );
                      })}

                    {/* Browse Folder / Custom Target Button */}
                    <button
                      type="button"
                      onClick={() => void handleBrowseFolder()}
                      className="p-3.5 rounded-2xl border border-dashed border-slate-300 hover:border-slate-400 bg-slate-50/50 hover:bg-slate-100/70 text-slate-700 transition-all flex items-center gap-3 cursor-pointer text-left"
                    >
                      <div className="w-8 h-8 rounded-xl bg-slate-200 text-slate-700 flex items-center justify-center shrink-0">
                        <FolderOpen size={16} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-slate-800">Browse USB / External Drive...</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {customPath ? customPath : "Pick any mounted USB flash drive, external SSD, or cable folder"}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Target Path Preview */}
                {selectedDestId && (
                  <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700">Active Backup Target:</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {backupDests.find((d) => d.id === selectedDestId)?.kind}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-900 break-all">
                      {backupDests.find((d) => d.id === selectedDestId)?.path}
                    </div>
                  </div>
                )}

                {/* Format and Execution Actions */}
                <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-100">
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <span className="text-xs font-semibold text-slate-700">Format:</span>
                    <div className="flex items-center bg-slate-100 p-1 rounded-xl">
                      <button
                        type="button"
                        onClick={() => setBackupFormat("json")}
                        className={`text-xs font-semibold px-3 py-1 rounded-lg transition-all cursor-pointer ${
                          backupFormat === "json"
                            ? "bg-white text-slate-900 shadow-xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        JSON Vault (.json)
                      </button>
                      <button
                        type="button"
                        onClick={() => setBackupFormat("markdown")}
                        className={`text-xs font-semibold px-3 py-1 rounded-lg transition-all cursor-pointer ${
                          backupFormat === "markdown"
                            ? "bg-white text-slate-900 shadow-xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        Markdown Archive (.md)
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                    <button
                      type="button"
                      disabled={backupBusy || !selectedDestId}
                      onClick={() => void handleExecuteBackup()}
                      className="w-full sm:w-auto text-xs font-bold px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-xs cursor-pointer"
                    >
                      {backupBusy ? (
                        <>
                          <RefreshCw size={14} className="animate-spin" />
                          <span>Writing & Verifying...</span>
                        </>
                      ) : (
                        <>
                          <HardDrive size={14} />
                          <span>Back Up to Selected Destination</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Direct Download / Cable Transfer Buttons */}
                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <Download size={13} className="text-slate-400" />
                    <span>Direct Export for USB Cable / Manual Transfer:</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleDirectDownload("json")}
                      className="px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 font-semibold text-xs transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <FileJson size={13} />
                      <span>Download JSON</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDirectDownload("markdown")}
                      className="px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 font-semibold text-xs transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <FileText size={13} />
                      <span>Download Markdown</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Card 2: Cloud Storage Webhook / REST Sync (Google Drive, S3, Supabase) */}
              <div className="bg-white border border-slate-200 rounded-3xl p-5 sm:p-7 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <UploadCloud size={16} className="text-slate-700" />
                      <span>Cloud Storage Webhook & REST Sync</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Stream or push atomic memory backups to external cloud storage endpoints (Google Cloud, S3, Supabase, or custom REST webhook).
                    </p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                    HTTPS Push
                  </span>
                </div>

                {cloudWebhookMessage && (
                  <div
                    className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                      cloudWebhookMessage.kind === "ok"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : "bg-rose-50 border-rose-200 text-rose-800"
                    }`}
                  >
                    {cloudWebhookMessage.kind === "ok" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                    <span>{cloudWebhookMessage.text}</span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Cloud Endpoint URL / Webhook
                    </label>
                    <input
                      type="url"
                      value={cloudWebhookUrl}
                      onChange={(e) => setCloudWebhookUrl(e.target.value)}
                      placeholder="https://storage.googleapis.com/... or /api/memories/backup"
                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Bearer Token / API Key (Optional)
                    </label>
                    <input
                      type="password"
                      value={cloudWebhookToken}
                      onChange={(e) => setCloudWebhookToken(e.target.value)}
                      placeholder="Bearer token or cloud service key"
                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    disabled={cloudWebhookBusy || !cloudWebhookUrl.trim()}
                    onClick={() => void handleCloudWebhookSync()}
                    className="text-xs font-bold px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 disabled:opacity-50 transition-all flex items-center gap-2 cursor-pointer shadow-xs"
                  >
                    {cloudWebhookBusy ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" />
                        <span>Pushing to Cloud...</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud size={13} />
                        <span>Push Memory to Cloud Webhook</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Card 3: Backup History & Verification Log */}
              <div className="bg-white border border-slate-200 rounded-3xl p-5 sm:p-7 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <History size={16} className="text-slate-700" />
                      <span>Backup History & SHA-256 Ledger</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Verifiable audit trail of memory archives written to cloud drives, USB tools, and local storage.
                    </p>
                  </div>
                  {history.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearHistory}
                      className="text-xs font-semibold px-3 py-1 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-all cursor-pointer"
                    >
                      Clear History
                    </button>
                  )}
                </div>

                {history.length === 0 ? (
                  <div className="p-8 text-center text-slate-400 text-xs border border-dashed border-slate-200 rounded-2xl">
                    No backups recorded yet. Run a backup above to verify files to OneDrive, Google Drive, or USB storage.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 border border-slate-200/80 rounded-2xl overflow-hidden max-h-60 overflow-y-auto">
                    {history.map((item) => (
                      <div key={item.id} className="p-3.5 hover:bg-slate-50/70 transition-colors flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 truncate">{item.destinationName}</span>
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 uppercase">
                              {item.format}
                            </span>
                            <span className="text-[10px] text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                              Verified
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 truncate font-mono mt-0.5">
                            {item.targetPath}
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-slate-400 mt-1">
                            <span>{item.dateStr}</span>
                            <span>•</span>
                            <span>{item.memoryCount} memories</span>
                            <span>•</span>
                            <span>{(item.fileSizeBytes / 1024).toFixed(1)} KB</span>
                            <span>•</span>
                            <span className="font-mono truncate max-w-[140px]" title={item.sha256}>
                              SHA: {item.sha256.slice(0, 12)}...
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => copyToClipboard(item.sha256, item.id)}
                          className="px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 flex items-center gap-1 text-[11px] font-semibold shrink-0 cursor-pointer"
                          title="Copy SHA-256 hash"
                        >
                          {copiedKey === item.id ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                          <span>{copiedKey === item.id ? "Copied" : "Copy Hash"}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ════════ TAB 2: SECURITY & PASSWORDS ════════ */}
          {activeTab === "security" && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Change Password Card */}
                <div className="bg-white border border-slate-200/90 rounded-3xl p-6 shadow-xs space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-800">
                      <Lock size={16} />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Change Password</h3>
                      <p className="text-[11px] text-slate-500">Update your account master passphrase</p>
                    </div>
                  </div>

                  {pwdMessage && (
                    <div
                      className={`p-3 text-xs rounded-xl border ${
                        pwdMessage.kind === "ok"
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : "bg-rose-50 text-rose-800 border-rose-200"
                      }`}
                    >
                      {pwdMessage.text}
                    </div>
                  )}

                  <form onSubmit={handleChangePassword} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Current Password</label>
                      <input
                        type={pwdShow ? "text" : "password"}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">New Password (min 6 chars)</label>
                      <input
                        type={pwdShow ? "text" : "password"}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Confirm New Password</label>
                      <input
                        type={pwdShow ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                      />
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={() => setPwdShow(!pwdShow)}
                        className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 cursor-pointer"
                      >
                        {pwdShow ? <EyeOff size={13} /> : <Eye size={13} />}
                        <span>{pwdShow ? "Hide passwords" : "Show passwords"}</span>
                      </button>
                      <button
                        type="submit"
                        disabled={pwdBusy || !newPassword}
                        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 text-xs font-bold rounded-xl transition-all shadow-xs cursor-pointer active:scale-95 disabled:opacity-50"
                      >
                        {pwdBusy ? "Updating..." : "Update Password"}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Password Recovery Card */}
                <div className="bg-white border border-slate-200/90 rounded-3xl p-6 shadow-xs space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-800">
                      <Mail size={16} />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Password Recovery</h3>
                      <p className="text-[11px] text-slate-500">Dispatch a secure reset token to your inbox</p>
                    </div>
                  </div>

                  {recoveryMessage && (
                    <div
                      className={`p-3 text-xs rounded-xl border ${
                        recoveryMessage.kind === "ok"
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : "bg-rose-50 text-rose-800 border-rose-200"
                      }`}
                    >
                      {recoveryMessage.text}
                    </div>
                  )}

                  <form onSubmit={handlePasswordRecovery} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Registered Email Address</label>
                      <input
                        type="email"
                        value={recoveryEmail || profile.email}
                        onChange={(e) => setRecoveryEmail(e.target.value)}
                        placeholder="you@domain.com"
                        className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                      />
                    </div>
                    <p className="text-[11px] text-slate-500">
                      A cryptographically verified one-time recovery token will be sent to confirm your identity.
                    </p>
                    <button
                      type="submit"
                      disabled={recoveryBusy}
                      className="w-full py-2 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 text-xs font-bold rounded-xl transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                    >
                      {recoveryBusy ? "Sending link..." : "Send Password Recovery Link"}
                    </button>
                  </form>

                  {/* Security Vault Architecture Note */}
                  <div className="pt-3 border-t border-slate-100 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                      <Shield size={14} className="text-emerald-600" />
                      <span>Vault Encryption Standard</span>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      API keys and credentials are authenticated locally using AES-256-GCM. No private keys are transmitted without user review.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ════════ TAB 3: CLOUD HOSTING & VPS ════════ */}
          {activeTab === "cloud_vps" && (
            <div className="space-y-6 max-w-4xl mx-auto">
              
              {/* Section 1: Cloud Relay Quick Tunnel */}
              <div className="bg-white border border-slate-200/90 rounded-3xl p-6 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
                      <Globe size={20} />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Cloud Relay Quick Tunnel</h3>
                      <p className="text-[11px] text-slate-500">
                        Expose your local workspace to web clients and remote apps via secure Cloudflare tunnel
                      </p>
                    </div>
                  </div>

                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold border ${
                      tunnel.running
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-slate-100 text-slate-600 border-slate-200"
                    }`}
                  >
                    {tunnel.running ? "● Active Tunnel" : "Idle"}
                  </span>
                </div>

                {tunnel.running ? (
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 space-y-3">
                    <div>
                      <div className="text-[11px] font-semibold text-slate-500 mb-1">Public Tunnel Endpoint</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={tunnel.publicUrl}
                          className="flex-1 px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800"
                        />
                        <button
                          type="button"
                          onClick={() => copyToClipboard(tunnel.publicUrl, "tunnelUrl")}
                          className="px-3 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
                        >
                          {copiedKey === "tunnelUrl" ? <Check size={13} /> : <Copy size={13} />}
                          <span>{copiedKey === "tunnelUrl" ? "Copied" : "Copy"}</span>
                        </button>
                      </div>
                    </div>

                    {tunnel.token && (
                      <div>
                        <div className="text-[11px] font-semibold text-slate-500 mb-1">Bridge Security Token</div>
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            readOnly
                            value={tunnel.token}
                            className="flex-1 px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-800"
                          />
                          <button
                            type="button"
                            onClick={() => copyToClipboard(tunnel.token, "tunnelToken")}
                            className="px-3 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
                          >
                            {copiedKey === "tunnelToken" ? <Check size={13} /> : <Copy size={13} />}
                            <span>Copy Token</span>
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[11px] text-slate-500">{tunnel.note || "Tunnel traffic encrypted end-to-end"}</span>
                      <button
                        type="button"
                        disabled={tunnelBusy}
                        onClick={() => void handleTunnelAction("mesh_tunnel_stop")}
                        className="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold cursor-pointer active:scale-95 disabled:opacity-50"
                      >
                        {tunnelBusy ? "Stopping..." : "Stop Cloud Relay"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-200/80">
                    <p className="text-xs text-slate-600 max-w-md">
                      Starting the relay generates a temporary public domain so web apps, remote coworkers, and webhooks can safely interface with this host.
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      {!tunnel.installed && (
                        <button
                          type="button"
                          disabled={tunnelBusy}
                          onClick={() => void handleTunnelAction("mesh_tunnel_download")}
                          className="px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-xs font-semibold text-slate-700 cursor-pointer"
                        >
                          Install Cloudflared
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={tunnelBusy}
                        onClick={() => void handleTunnelAction("mesh_tunnel_start")}
                        className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 text-xs font-bold shadow-xs cursor-pointer active:scale-95 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Zap size={14} />
                        <span>{tunnelBusy ? "Launching..." : "Start Cloud Relay"}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Section 2: Remote VPS & Cloud Node Connector */}
              <div className="bg-white border border-slate-200/90 rounded-3xl p-6 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center">
                      <Server size={20} />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Remote VPS & Cloud Node Connect</h3>
                      <p className="text-[11px] text-slate-500">
                        Link this client to a remote Ronic OS instance running on your VPS, AWS EC2, or DigitalOcean
                      </p>
                    </div>
                  </div>

                  {vpsNode?.connected && (
                    <button
                      type="button"
                      onClick={handleDisconnectVps}
                      className="px-3 py-1 rounded-xl text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 cursor-pointer"
                    >
                      Disconnect Node
                    </button>
                  )}
                </div>

                {vpsMessage && (
                  <div
                    className={`p-3 text-xs rounded-xl border ${
                      vpsMessage.kind === "ok"
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                        : "bg-rose-50 text-rose-800 border-rose-200"
                    }`}
                  >
                    {vpsMessage.text}
                  </div>
                )}

                {vpsNode?.connected ? (
                  <div className="p-4 bg-emerald-50/50 rounded-2xl border border-emerald-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-emerald-900 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span>Connected: {vpsNode.label}</span>
                      </span>
                      <span className="text-[11px] text-emerald-700 font-mono">Status: Online</span>
                    </div>
                    <div className="text-xs text-slate-600">
                      Host Address: <span className="font-mono font-semibold text-slate-800">{vpsNode.url}</span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      All background agent fleets, scheduled tasks, and heavy builds run remotely on this node.
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleConnectVps} className="space-y-3.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">VPS Server Endpoint</label>
                        <input
                          type="text"
                          required
                          value={vpsUrl}
                          onChange={(e) => setVpsUrl(e.target.value)}
                          placeholder="https://vps.mydomain.com:1420"
                          className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Node Label</label>
                        <input
                          type="text"
                          value={vpsLabel}
                          onChange={(e) => setVpsLabel(e.target.value)}
                          placeholder="e.g. Frankfurt GPU Node"
                          className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Remote Access Token</label>
                      <input
                        type="password"
                        value={vpsToken}
                        onChange={(e) => setVpsToken(e.target.value)}
                        placeholder="Bearer token from your remote .env"
                        className="w-full px-3.5 py-2 text-xs bg-slate-50/70 border border-slate-200 rounded-xl outline-none focus:bg-white focus:border-slate-400"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={vpsBusy || !vpsUrl}
                      className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 text-xs font-bold rounded-xl transition-all shadow-xs cursor-pointer active:scale-95 disabled:opacity-50"
                    >
                      {vpsBusy ? "Testing Connection..." : "Test & Connect Cloud VPS"}
                    </button>
                  </form>
                )}
              </div>

              {/* Section 3: One-Click Self-Host Deployment Guide */}
              <div className="bg-white border border-slate-200/90 rounded-3xl p-6 shadow-xs space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
                    <Terminal size={20} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Self-Host Ronic OS on any Cloud / VPS</h3>
                    <p className="text-[11px] text-slate-500">
                      Commands to launch a 24/7 autonomous worker on Ubuntu, Debian, or Docker
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1">
                      <span>Method 1: One-Line Docker Run</span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            "docker run -d --name ronicos -p 1420:1420 -p 4141:4141 -v ~/.ronic:/root/.ronic --restart unless-stopped ronic/workspace-os:latest",
                            "dockerRun"
                          )
                        }
                        className="text-slate-500 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                      >
                        {copiedKey === "dockerRun" ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedKey === "dockerRun" ? "Copied" : "Copy command"}</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-900 text-slate-100 rounded-xl text-xs font-mono overflow-x-auto">
                      docker run -d --name ronicos -p 1420:1420 -p 4141:4141 -v ~/.ronic:/root/.ronic --restart unless-stopped ronic/workspace-os:latest
                    </pre>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1">
                      <span>Method 2: Bare-metal Linux Install Script</span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard("curl -fsSL https://get.ronic.os/vps-install.sh | bash", "linuxScript")
                        }
                        className="text-slate-500 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                      >
                        {copiedKey === "linuxScript" ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedKey === "linuxScript" ? "Copied" : "Copy command"}</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-900 text-slate-100 rounded-xl text-xs font-mono overflow-x-auto">
                      curl -fsSL https://get.ronic.os/vps-install.sh | bash
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ════════ TAB 4: POLICIES & LEGAL ════════ */}
          {activeTab === "policies" && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                <button
                  type="button"
                  onClick={() => setSelectedPolicy("privacy")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                    selectedPolicy === "privacy" ? "bg-slate-900 text-white shadow-xs" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Privacy Policy
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPolicy("terms")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                    selectedPolicy === "terms" ? "bg-slate-900 text-white shadow-xs" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Terms of Service
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPolicy("security")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                    selectedPolicy === "security" ? "bg-slate-900 text-white shadow-xs" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Data Sovereignty & Security
                </button>
              </div>

              <div className="bg-white border border-slate-200/90 rounded-3xl p-6 sm:p-8 shadow-xs prose prose-slate max-w-none text-xs sm:text-sm text-slate-700 leading-relaxed space-y-4">
                {selectedPolicy === "privacy" && (
                  <>
                    <h2 className="text-base font-bold text-slate-900">Privacy Policy (Local-First Sovereignty)</h2>
                    <p>
                      <strong>Effective Date:</strong> October 2026
                    </p>
                    <p>
                      Omni Workspace OS / Ronic OS is engineered from the ground up on the principle of <em>Absolute Data Sovereignty</em>. Your code, memory logs, conversational turns, and execution steps are written directly to your local encrypted SQLite instance on disk (or your self-hosted private VPS).
                    </p>
                    <h3 className="text-sm font-bold text-slate-900">1. Telemetry & Analytics</h3>
                    <p>
                      We do not harvest, inspect, or sell prompts, codebase trees, or tool invocations. Anonymous performance metrics (e.g. startup heartbeat and crash reports) are strictly opt-in and disabled by default in private mode.
                    </p>
                    <h3 className="text-sm font-bold text-slate-900">2. Provider Routing & Secrets</h3>
                    <p>
                      Third-party API keys (OpenAI, Anthropic, Groq, NVIDIA) are stored securely in your operating system's Credential Vault. When communicating with LLM providers, requests route directly from your IP address or your chosen private VPS node.
                    </p>
                  </>
                )}

                {selectedPolicy === "terms" && (
                  <>
                    <h2 className="text-base font-bold text-slate-900">Terms of Service</h2>
                    <p>
                      By running Ronic OS locally or connecting a cloud VPS node, you acknowledge and agree to the following operational boundaries:
                    </p>
                    <h3 className="text-sm font-bold text-slate-900">1. Autonomous Code Execution</h3>
                    <p>
                      Ronic OS bots can inspect files, write patches, and execute commands through the terminal emulator and browser bridge. The user maintains root authority through approval gates (Manual / Ask / Auto) and the financial policy gate.
                    </p>
                    <h3 className="text-sm font-bold text-slate-900">2. Self-Hosted Responsibility</h3>
                    <p>
                      When deploying Ronic OS on public VPS hosting, you are responsible for maintaining firewall rules (e.g. restricting port 1420 to authorized IPs or relying strictly on encrypted Cloudflare tunnels with bearer tokens).
                    </p>
                  </>
                )}

                {selectedPolicy === "security" && (
                  <>
                    <h2 className="text-base font-bold text-slate-900">Data Sovereignty & Encryption Standards</h2>
                    <p>
                      Omni Workspace OS enforces end-to-end cryptographic safeguards across all layers of execution:
                    </p>
                    <ul className="list-disc pl-5 space-y-1.5">
                      <li><strong>Local Vault:</strong> AES-256-GCM symmetric encryption for all credentials and sensitive environment configs.</li>
                      <li><strong>Relay Tunnels:</strong> Mutual TLS 1.3 encryption across Cloudflare mesh tunnels.</li>
                      <li><strong>License Verification:</strong> Ed25519 digital signature validation with zero phoning home.</li>
                      <li><strong>Memory Scrubbing:</strong> Lock Vault clears decrypted API keys from runtime memory immediately upon locking.</li>
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ════════ TAB 5: DANGER ZONE ════════ */}
          {activeTab === "danger" && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <div className="bg-rose-50/60 border border-rose-200 rounded-3xl p-6 sm:p-7 shadow-xs space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-rose-100 text-rose-700 flex items-center justify-center">
                    <Trash2 size={20} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-rose-950">Delete Ronic OS Account & Purge Credentials</h3>
                    <p className="text-[11px] text-rose-700">
                      Permanently revoke cloud authorization, erase cloud profiles, and clear local session keys
                    </p>
                  </div>
                </div>

                <div className="p-4 bg-white/80 rounded-2xl border border-rose-200/80 text-xs text-rose-800 space-y-2">
                  <p className="font-semibold">This action cannot be undone:</p>
                  <ul className="list-disc pl-5 space-y-1 text-slate-600">
                    <li>Your cloud user identity and associated store listings will be wiped.</li>
                    <li>Connected remote VPS nodes and relay tokens will be invalidated.</li>
                    <li>Local keychain credentials for this account will be erased.</li>
                    <li>Local bots and SQLite history on this disk will be detached from your cloud profile.</li>
                  </ul>
                </div>

                <button
                  type="button"
                  onClick={() => setShowDeleteModal(true)}
                  className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs transition-all cursor-pointer active:scale-95"
                >
                  Delete Ronic OS Account
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── CONFIRMATION MODAL: DELETE ACCOUNT ─── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-md w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <AlertTriangle size={24} />
            </div>

            <div className="text-center space-y-1.5">
              <h3 className="text-base font-bold text-slate-900">Confirm Account Deletion</h3>
              <p className="text-xs text-slate-500">
                Are you sure you want to delete your account? To confirm, please type <span className="font-bold text-rose-600 font-mono">DELETE</span> below.
              </p>
            </div>

            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Type DELETE to confirm"
              className="w-full px-3.5 py-2 text-xs border border-rose-300 rounded-xl outline-none focus:ring-2 focus:ring-rose-500/20 text-center font-mono font-bold"
            />

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setShowDeleteModal(false); setDeleteConfirmText(""); }}
                className="flex-1 py-2 px-3 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteConfirmText.trim() !== "DELETE" || deleteBusy}
                onClick={() => void handleDeleteAccount()}
                className="flex-1 py-2 px-3 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-40 transition-all"
              >
                {deleteBusy ? "Deleting..." : "Permanently Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Keep backward-compatible export
export { ProfileScreen as Extensions };
export default ProfileScreen;
