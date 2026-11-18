import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns,
  Copy,
  Cpu,
  Database,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommit,
  GripVertical,
  History,
  MessageSquare,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { call, invokeRaw, isTauri, pickPaths } from "../api";
import {
  appendTurn,
  buildDispatchEnvelope,
  buildHistorySummary,
  clampFileIndex,
  clampLayout,
  createSession,
  DEFAULT_LAYOUT,
  deleteSession,
  dispatchOutput,
  fileContentFromPayload,
  filesAfterDispatch,
  filesFromPayload,
  gitMetaFromPayload,
  ideToOpen,
  indexAfterRefresh,
  interactiveCliCommand,
  loadCustomModels,
  loadEffortMap,
  loadLayout,
  loadProjects,
  loadSelectedModels,
  loadSessions,
  mergeModelOptions,
  modelsFromPayload,
  normalizeProjectKey,
  projectLabel,
  removeProject,
  renameSession,
  reorderPanes,
  saveCustomModels,
  saveEffortMap,
  saveLayout,
  saveProjects,
  saveSelectedModels,
  saveSessions,
  syncReportFromPayload,
  togglePinProject,
  treeFromPayload,
  upsertProject,
  type CodingEffort,
  type CodingLayout,
  type CodingSession,
  type HarnessModelOption,
  type HarnessSyncReport,
  type ModifiedFile,
  type PaneId,
  type ProjectEntry,
  type ProjectFileContent,
  type ProjectTreeEntry,
} from "../kernel/codingAgents";
import { catalog as connectedCatalog } from "../kernel/modelPrefs";
import { launchDesktopApp } from "../lib/tauriBridge";
import { useRonic } from "../store";
import TerminalPanel, { type TerminalPanelHandle } from "../components/TerminalPanel";

type FastGitResult = { toast?: string | null; payload?: unknown };

async function gitFast(
  action: string,
  path = "",
  agent = "",
  prompt = "",
): Promise<FastGitResult | null> {
  try {
    if (isTauri()) {
      try {
        return await invokeRaw<FastGitResult>("workspace_git_fast", { action, path, agent, prompt });
      } catch (err) {
        // Fallback if desktop binary hasn't been rebuilt with workspace_git_fast yet.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("workspace_git_fast")) throw err;
      }
    }
    const res = await call("workspace_git", { action, path, agent, prompt });
    return { toast: res.toast, payload: res.payload };
  } catch (err) {
    return { toast: err instanceof Error ? err.message : String(err), payload: null };
  }
}

interface AgentHarness {
  id: "claude" | "aider" | "opencode" | "codex" | "gemini" | "cursor" | "vscode";
  label: string;
  category: "cli" | "ide";
  mcpNative: boolean;
}

const HARNESSES: AgentHarness[] = [
  { id: "claude", label: "Claude Code CLI", category: "cli", mcpNative: true },
  { id: "aider", label: "Aider", category: "cli", mcpNative: false },
  { id: "opencode", label: "OpenCode CLI", category: "cli", mcpNative: true },
  { id: "codex", label: "Codex CLI", category: "cli", mcpNative: true },
  { id: "gemini", label: "Gemini CLI", category: "cli", mcpNative: true },
  { id: "cursor", label: "Cursor", category: "ide", mcpNative: true },
  { id: "vscode", label: "VS Code", category: "ide", mcpNative: true },
];

function labelFor(id: string): string {
  return HARNESSES.find((item) => item.id === id)?.label ?? id;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function CodingAgentsWorkspace() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const setToast = useRonic((s) => s.setToast);
  const go = useRonic((s) => s.go);

  const projectRoot = snap.settings.projectRoot || "";
  const activeProfileId = snap.activeProfileId || snap.profiles?.[0]?.id || "bot_default";

  // Active harness
  const [activeAgent, setActiveAgent] = useState<AgentHarness["id"]>(
    (snap.ideAgent as AgentHarness["id"]) || "claude",
  );

  // Draggable & adjustable layout state (persisted)
  const [layout, setLayout] = useState<CodingLayout>(() => loadLayout());
  const [draggingPane, setDraggingPane] = useState<PaneId | null>(null);
  const [dragOverPane, setDragOverPane] = useState<PaneId | null>(null);

  // Projects list (persisted)
  const [projects, setProjects] = useState<ProjectEntry[]>(() => loadProjects(projectRoot));

  // Sessions & chat history (persisted)
  const [sessions, setSessions] = useState<CodingSession[]>(() => {
    const existing = loadSessions();
    if (existing.length > 0) return existing;
    return [createSession(projectRoot, (snap.ideAgent as AgentHarness["id"]) || "claude")];
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0]?.id || "");
  const [sessionSearch, setSessionSearch] = useState<string>("");
  const [sessionScope, setSessionScope] = useState<"project" | "all">("project");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");

  // Explorer tabs
  const [leftTopTab, setLeftTopTab] = useState<"projects" | "sessions">("projects");
  const [leftBottomTab, setLeftBottomTab] = useState<"files" | "changes">("files");

  // Files tree + file viewer
  const [treeByPath, setTreeByPath] = useState<Record<string, ProjectTreeEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [loadingTree, setLoadingTree] = useState<boolean>(false);
  const [fileFilter, setFileFilter] = useState<string>("");
  const [creatingFile, setCreatingFile] = useState<boolean>(false);
  const [newFilePath, setNewFilePath] = useState<string>("");
  const [openFile, setOpenFile] = useState<ProjectFileContent | null>(null);
  const [loadingFile, setLoadingFile] = useState<boolean>(false);
  const [isEditingFile, setIsEditingFile] = useState<boolean>(false);
  const [editDraft, setEditDraft] = useState<string>("");
  const [savingFile, setSavingFile] = useState<boolean>(false);

  // Git state
  const [files, setFiles] = useState<ModifiedFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
  const [isGitRepo, setIsGitRepo] = useState<boolean>(true);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [isScanningGit, setIsScanningGit] = useState<boolean>(false);
  const [treeNote, setTreeNote] = useState<string>("Reading the git working tree…");
  const [commitMsg, setCommitMsg] = useState<string>("");

  // Center viewer tab (when viewing code/diff)
  const [codeTab, setCodeTab] = useState<"file" | "diff">("file");

  // Prompt composer & dispatch options
  const [taskPrompt, setTaskPrompt] = useState<string>("");
  const [isDispatching, setIsDispatching] = useState<boolean>(false);
  const [streamingPrompt, setStreamingPrompt] = useState<string>("");
  const [streamingOutput, setStreamingOutput] = useState<string>("");
  const [dispatchStartedAt, setDispatchStartedAt] = useState<number>(0);
  const [firstByteMs, setFirstByteMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [injectContext, setInjectContext] = useState<boolean>(true);
  const [fastContext, setFastContext] = useState<boolean>(true);
  const [autoApprove, setAutoApprove] = useState<boolean>(true);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Direct manual model switcher & reasoning effort (persisted per harness)
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, HarnessModelOption[]>>({});
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>(() => loadSelectedModels());
  const [customModels, setCustomModels] = useState<Record<string, string[]>>(() => loadCustomModels());
  const [effortByAgent, setEffortByAgent] = useState<Record<string, CodingEffort>>(() => loadEffortMap());
  const [modelPickerOpen, setModelPickerOpen] = useState<boolean>(false);
  const [modelSearch, setModelSearch] = useState<string>("");
  const [customModelDraft, setCustomModelDraft] = useState<string>("");
  const [loadingModels, setLoadingModels] = useState<boolean>(false);

  // Capabilities panel & automatic harness sync
  const [capTab, setCapTab] = useState<"skills" | "plugins" | "mcp" | "memory">("skills");
  const [capSearch, setCapSearch] = useState<string>("");
  const [syncReport, setSyncReport] = useState<HarnessSyncReport | null>(null);
  const [isSyncingHarness, setIsSyncingHarness] = useState<boolean>(false);

  // Refs for layout drag measurements and terminal control
  const explorerBodyRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalPanelHandle | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const dispatchStartedRef = useRef<number>(0);
  const firstByteRecordedRef = useRef<boolean>(false);
  const streamingOutputRef = useRef<string>("");

  const detectedPaths: Record<string, string> = useMemo(
    () => ({
      aider: snap.settings.aiderPath || "",
      opencode: snap.settings.opencodePath || "",
      claude: snap.settings.claudePath || "",
      codex: snap.settings.codexPath || "",
      gemini: snap.settings.geminiPath || "",
      cursor: (snap.apps || []).find((app) => app.id === "app_cursor")?.executablePath || "",
      vscode: (snap.apps || []).find((app) => app.id === "app_vscode")?.executablePath || "",
      uv: snap.settings.uvPath || "",
      bun: snap.settings.bunPath || "",
    }),
    [snap.settings, snap.apps],
  );

  // Persist layout, projects, sessions
  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  useEffect(() => {
    saveProjects(projects);
  }, [projects]);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    saveSelectedModels(selectedModels);
  }, [selectedModels]);

  useEffect(() => {
    saveCustomModels(customModels);
  }, [customModels]);

  useEffect(() => {
    saveEffortMap(effortByAgent);
  }, [effortByAgent]);

  // Close model picker popover on outside click
  useEffect(() => {
    if (!modelPickerOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(ev.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelPickerOpen]);

  // Live streaming listener for coding agent stdout/stderr chunks
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let mounted = true;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ agent?: string; chunk?: string; done?: boolean }>("coding-agent-stream", (event) => {
        if (!mounted) return;
        const chunk = event.payload?.chunk || "";
        if (chunk) {
          if (!firstByteRecordedRef.current && dispatchStartedRef.current > 0) {
            firstByteRecordedRef.current = true;
            setFirstByteMs(Date.now() - dispatchStartedRef.current);
          }
          setStreamingOutput((prev) => {
            const next = prev.length > 24_000 ? prev : prev + chunk;
            streamingOutputRef.current = next;
            return next;
          });
        }
      }).then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      });
    });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, []);

  // Live elapsed timer while dispatching
  useEffect(() => {
    if (!isDispatching || !dispatchStartedAt) return;
    const timer = window.setInterval(() => {
      setElapsedSec((Date.now() - dispatchStartedAt) / 1000);
    }, 200);
    return () => window.clearInterval(timer);
  }, [isDispatching, dispatchStartedAt]);

  // Sync active projectRoot into projects list
  useEffect(() => {
    if (projectRoot.trim()) {
      setProjects((prev) => upsertProject(prev, projectRoot));
    }
  }, [projectRoot]);

  // Keep activeAgent aligned with snapshot
  useEffect(() => {
    if (snap.ideAgent && snap.ideAgent !== activeAgent) {
      const match = HARNESSES.find((h) => h.id === snap.ideAgent);
      if (match) setActiveAgent(match.id);
    }
  }, [snap.ideAgent, activeAgent]);

  // Ensure an active session always exists
  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0];
  }, [sessions, activeSessionId]);

  useEffect(() => {
    if (!activeSession && sessions.length === 0) {
      const fresh = createSession(projectRoot, activeAgent);
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
    } else if (activeSession && activeSession.id !== activeSessionId) {
      setActiveSessionId(activeSession.id);
    }
  }, [activeSession, activeSessionId, sessions.length, projectRoot, activeAgent]);

  // Scroll chat to bottom when turns or streaming chunks update
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [activeSession?.turns.length, isDispatching, streamingOutput.length]);

  const showFiles = useCallback((next: ModifiedFile[], note?: string) => {
    setFiles((prev) => {
      setSelectedFileIndex((current) => indexAfterRefresh(prev, next, current));
      return next;
    });
    if (note !== undefined) setTreeNote(note);
  }, []);

  const refreshGitStatus = useCallback(async () => {
    setIsScanningGit(true);
    try {
      const res = await gitFast("status");
      const meta = gitMetaFromPayload(res?.payload);
      if (meta) {
        setIsGitRepo(meta.isGit);
        setGitBranch(meta.branch);
      }
      const next = filesFromPayload(res?.payload);
      if (next) {
        showFiles(
          next,
          meta && !meta.isGit
            ? "Not a git repository yet. Click Init Git or browse Files."
            : next.length === 0
              ? res?.toast || "Working tree is clean."
              : res?.toast || "",
        );
      } else {
        setTreeNote(res?.toast || "Could not read git status.");
      }
    } finally {
      setIsScanningGit(false);
    }
  }, [showFiles]);

  const loadDirectory = useCallback(async (relPath: string) => {
    if (!relPath) setLoadingTree(true);
    try {
      const res = await gitFast("tree", relPath);
      const entries = treeFromPayload(res?.payload);
      if (entries) {
        setTreeByPath((prev) => ({ ...prev, [relPath]: entries }));
      }
    } finally {
      if (!relPath) setLoadingTree(false);
    }
  }, []);

  const syncHarnessNow = useCallback(async (agentId: AgentHarness["id"], silent = false) => {
    setIsSyncingHarness(true);
    try {
      const res = await gitFast("sync_harness", "", agentId);
      const report = syncReportFromPayload(res?.payload);
      if (report) setSyncReport(report);
      if (!silent && res?.toast) setActionNotice(res.toast);
    } finally {
      setIsSyncingHarness(false);
    }
  }, []);

  const loadModelsForHarness = useCallback(async (agentId: AgentHarness["id"], forceRefresh = false) => {
    setLoadingModels(true);
    try {
      const res = await gitFast("list_models", forceRefresh ? "refresh" : "", agentId);
      const list = modelsFromPayload(res?.payload);
      if (list) {
        setModelsByAgent((prev) => ({ ...prev, [agentId]: list }));
      }
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // Load git status, project file tree, harness sync, and models IN PARALLEL when projectRoot changes
  useEffect(() => {
    setTreeByPath({});
    setExpandedDirs({});
    setOpenFile(null);
    setIsEditingFile(false);
    void Promise.all([
      refreshGitStatus(),
      loadDirectory(""),
      syncHarnessNow(activeAgent, true),
      loadModelsForHarness(activeAgent, false),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // Also ensure models are loaded whenever activeAgent changes
  useEffect(() => {
    if (!modelsByAgent[activeAgent]) {
      void loadModelsForHarness(activeAgent, false);
    }
  }, [activeAgent, modelsByAgent, loadModelsForHarness]);

  const activeFile = files[clampFileIndex(selectedFileIndex, files.length)];
  const agentPath = detectedPaths[activeAgent] || "";
  const agentReady = agentPath.trim().length > 0;
  const activeLabel = labelFor(activeAgent);

  // Connected Ronic OS / Ollama models merged with live CLI / preset models + custom models
  const connectedModels: HarnessModelOption[] = useMemo(() => {
    const keyedIds = (snap.providers || []).filter((p) => p.hasSecret).map((p) => p.id);
    const ollamaReady = (snap.providers || []).some((p) => p.id === "prov_ollama" && p.isActive);
    return connectedCatalog(keyedIds, ollamaReady).map((m) => ({
      id: m.upstreamModel,
      label: `${m.label} (${m.group})`,
      tier: /flash|haiku|mini|lite|low/i.test(m.upstreamModel) ? "fast" : /opus|o3|pro/i.test(m.upstreamModel) ? "deep" : "balanced",
      source: "connected" as const,
    }));
  }, [snap.providers]);

  const availableModels = useMemo(() => {
    return mergeModelOptions(
      modelsByAgent[activeAgent] || [],
      connectedModels,
      customModels[activeAgent] || [],
    );
  }, [modelsByAgent, activeAgent, connectedModels, customModels]);

  const activeModelId = selectedModels[activeAgent] || "";
  const activeModelObj = useMemo(
    () => availableModels.find((m) => m.id === activeModelId) || null,
    [availableModels, activeModelId],
  );
  const activeEffort: CodingEffort = effortByAgent[activeAgent] || "auto";

  function handleSelectModel(modelId: string) {
    setSelectedModels((prev) => ({ ...prev, [activeAgent]: modelId }));
    setModelPickerOpen(false);
    setModelSearch("");
    setToast(modelId ? `${activeLabel} model switched to ${modelId}` : `${activeLabel} set to harness default model`);
  }

  function handleAddCustomModel() {
    const clean = customModelDraft.trim();
    if (!clean || /[\s"'&|;]/.test(clean)) return;
    setCustomModels((prev) => {
      const existing = prev[activeAgent] || [];
      return existing.includes(clean) ? prev : { ...prev, [activeAgent]: [clean, ...existing] };
    });
    setCustomModelDraft("");
    handleSelectModel(clean);
  }

  function handleSelectEffort(eff: CodingEffort) {
    setEffortByAgent((prev) => ({ ...prev, [activeAgent]: eff }));
  }

  // Automatically sync Ronic OS skills, plugins, MCP servers & models whenever a harness is selected
  async function handleSelectAgent(agentId: AgentHarness["id"]) {
    setActiveAgent(agentId);
    setIsSyncingHarness(true);
    try {
      const [res] = await Promise.all([
        run("set_ide_agent", { agent: agentId }),
        loadModelsForHarness(agentId, false),
      ]);
      const report = syncReportFromPayload(res?.payload);
      if (report) {
        setSyncReport(report);
        setActionNotice(
          `${labelFor(agentId)} selected — auto-synced ${report.skillsCount} skills, ${report.pluginsCount} plugins, ${report.mcpCount} MCP servers.`,
        );
      } else {
        await syncHarnessNow(agentId, false);
      }
    } finally {
      setIsSyncingHarness(false);
    }
  }

  async function handleSwitchProject(nextRoot: string) {
    const clean = nextRoot.trim();
    if (!clean) return;
    setProjects((prev) => upsertProject(prev, clean));
    if (normalizeProjectKey(clean) === normalizeProjectKey(projectRoot)) return;
    await run("save_settings", {
      settings: {
        ...snap.settings,
        projectRoot: clean,
      },
    });
    setToast(`Switched project to ${projectLabel(clean)}`);
  }

  async function handleAddProject() {
    try {
      const paths = await pickPaths("folder");
      if (paths && paths.length > 0 && paths[0]) {
        await handleSwitchProject(paths[0]);
      }
    } catch (err) {
      console.error("Failed to pick folder:", err);
    }
  }

  async function handleToggleDir(dirPath: string) {
    const nextOpen = !expandedDirs[dirPath];
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: nextOpen }));
    if (nextOpen && !treeByPath[dirPath]) {
      await loadDirectory(dirPath);
    }
  }

  async function handleOpenFile(relPath: string) {
    setLoadingFile(true);
    setIsEditingFile(false);
    try {
      const res = await gitFast("read_file", relPath);
      const content = fileContentFromPayload(res?.payload);
      if (content) {
        setOpenFile(content);
        setEditDraft(content.content);
        setCodeTab("file");
        if (layout.centerMode === "chat") {
          setLayout((prev) => ({ ...prev, centerMode: "split" }));
        }
      } else if (res?.toast) {
        setActionNotice(res.toast);
      }
    } finally {
      setLoadingFile(false);
    }
  }

  async function handleSaveOpenFile() {
    if (!openFile) return;
    setSavingFile(true);
    try {
      const res = await gitFast("write_file", openFile.path, "", editDraft);
      if (res && res.payload) {
        setOpenFile({
          ...openFile,
          content: editDraft,
          lines: editDraft.split("\n").length,
          size: editDraft.length,
        });
        setIsEditingFile(false);
        setActionNotice(res.toast || `Saved ${openFile.path}.`);
        void refreshGitStatus();
      } else if (res?.toast) {
        setActionNotice(res.toast);
      }
    } finally {
      setSavingFile(false);
    }
  }

  function addAttachedFile(relPath: string) {
    setAttachedFiles((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]));
  }

  function toggleSelectedSkill(slug: string) {
    setSelectedSkills((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  }

  function handleNewSession() {
    const fresh = createSession(projectRoot, activeAgent);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setLeftTopTab("sessions");
  }

  async function handleCreateNewFile() {
    const clean = newFilePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean) return;
    const res = await gitFast("write_file", clean, "", "");
    if (res?.payload) {
      setNewFilePath("");
      setCreatingFile(false);
      setTreeByPath({});
      await loadDirectory("");
      await handleOpenFile(clean);
      setIsEditingFile(true);
      setActionNotice(`Created ${clean}.`);
    } else if (res?.toast) {
      setActionNotice(res.toast);
    }
  }

  async function handleCancelDispatch() {
    if (!isDispatching) return;
    const res = await gitFast("cancel");
    if (res?.toast) setActionNotice(res.toast);
  }

  function handleCdProjectInTerminal(targetRoot: string) {
    const clean = targetRoot.trim();
    if (!clean) return;
    if (!layout.showTerminal) {
      setLayout((prev) => ({ ...prev, showTerminal: true }));
    }
    const isWin = typeof navigator !== "undefined" && navigator.platform.includes("Win");
    const safeRoot = clean.replace(/"/g, "");
    const cmd = isWin ? `Set-Location -LiteralPath "${safeRoot}"` : `cd "${safeRoot}"`;
    setTimeout(() => {
      terminalRef.current?.sendCommand(cmd);
      terminalRef.current?.focus();
    }, 60);
  }

  async function handleDispatch(overridePrompt?: string) {
    const prompt = (overridePrompt ?? taskPrompt).trim();
    if (!prompt) return;
    if (!agentReady) {
      setActionNotice(`${activeLabel} is not linked. Scan this computer, or set its path in Apps.`);
      return;
    }

    // Ensure we have a session to record into
    let targetSessionId = activeSession?.id;
    if (!targetSessionId) {
      const fresh = createSession(projectRoot, activeAgent);
      setSessions((prev) => [fresh, ...prev]);
      setActiveSessionId(fresh.id);
      targetSessionId = fresh.id;
    }

    const startedAt = Date.now();
    dispatchStartedRef.current = startedAt;
    firstByteRecordedRef.current = false;
    streamingOutputRef.current = "";
    setDispatchStartedAt(startedAt);
    setFirstByteMs(null);
    setElapsedSec(0);
    setStreamingPrompt(prompt);
    setStreamingOutput("");
    setIsDispatching(true);
    setActionNotice(null);
    if (overridePrompt === undefined) {
      setTaskPrompt("");
    }

    try {
      const historySummary = injectContext ? buildHistorySummary(activeSession, fastContext ? 2 : 3) : "";
      const envelope = buildDispatchEnvelope({
        text: prompt,
        injectContext,
        autoApprove,
        fastContext,
        model: activeModelId,
        effort: activeEffort,
        historySummary,
        attachedFiles,
        selectedSkills,
      });

      const res = await gitFast("dispatch", "", activeAgent, envelope);
      const durationMs = Date.now() - startedAt;
      const streamedSoFar = streamingOutputRef.current;

      if (!res || !res.payload) {
        const errMsg = res?.toast || "The agent did not finish.";
        setActionNotice(errMsg);
        setSessions((prev) =>
          appendTurn(prev, targetSessionId!, {
            id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            prompt,
            output: streamedSoFar || errMsg,
            agent: activeAgent,
            model: activeModelId || undefined,
            exitCode: 1,
            createdAt: startedAt,
            durationMs,
            attachedFiles: [...attachedFiles],
            selectedSkills: [...selectedSkills],
            changedFiles: [],
          }),
        );
        return;
      }

      const next = filesAfterDispatch(files, res.payload);
      showFiles(next);
      const output = dispatchOutput(res.payload);
      const report = syncReportFromPayload(res.payload);
      if (report) setSyncReport(report);
      const exitCode =
        res.payload && typeof res.payload === "object" && typeof (res.payload as { exitCode?: unknown }).exitCode === "number"
          ? (res.payload as { exitCode: number }).exitCode
          : null;

      setSessions((prev) =>
        appendTurn(prev, targetSessionId!, {
          id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          prompt,
          output: output || streamedSoFar || res.toast || "(Completed with no stdout output.)",
          agent: activeAgent,
          model: activeModelId || undefined,
          exitCode,
          createdAt: startedAt,
          durationMs,
          attachedFiles: [...attachedFiles],
          selectedSkills: [...selectedSkills],
          changedFiles: next.map((f) => f.path),
        }),
      );

      setActionNotice(res.toast || "Dispatch completed.");
      void loadDirectory("");
      if (openFile && !isEditingFile) {
        void handleOpenFile(openFile.path);
      }
    } finally {
      setIsDispatching(false);
      setStreamingPrompt("");
      setStreamingOutput("");
      streamingOutputRef.current = "";
      dispatchStartedRef.current = 0;
    }
  }

  async function handleGitAction(action: "stage" | "unstage" | "stage_all" | "restore" | "commit" | "git_init", path = "", prompt = "") {
    const res = await gitFast(action, path, "", prompt);
    const next = filesFromPayload(res?.payload);
    if (next) showFiles(next);
    const meta = gitMetaFromPayload(res?.payload);
    if (meta) {
      setIsGitRepo(meta.isGit);
      setGitBranch(meta.branch);
    }
    if (action === "commit" && res?.payload) setCommitMsg("");
    if (res?.toast) setActionNotice(res.toast);
  }

  const idePartner = ideToOpen(activeAgent, {
    cursor: Boolean(detectedPaths.cursor),
    vscode: Boolean(detectedPaths.vscode),
  });
  const ideLabel = idePartner === "vscode" ? "VS Code" : "Cursor";
  const ideReady = Boolean(detectedPaths[idePartner]);

  function handleOpenIde() {
    if (!isTauri()) {
      setActionNotice("The desktop app opens Cursor or VS Code on this computer.");
      return;
    }
    if (!ideReady) {
      setActionNotice(`${ideLabel} is not installed on this computer.`);
      return;
    }
    void launchDesktopApp(idePartner, "desktop", projectRoot ? { path: projectRoot } : undefined)
      .then((res) => setActionNotice(res?.toast || `Opening ${ideLabel} on the project folder.`))
      .catch((err: unknown) => setActionNotice(err instanceof Error ? err.message : `Could not open ${ideLabel}.`));
  }

  function handleLaunchInteractiveInTerminal() {
    if (!layout.showTerminal) {
      setLayout((prev) => ({ ...prev, showTerminal: true }));
    }
    if (!agentReady) {
      setActionNotice(`${activeLabel} is not linked yet.`);
      return;
    }
    const isWin = typeof navigator !== "undefined" && navigator.platform.includes("Win");
    const cmd = interactiveCliCommand({
      agent: activeAgent,
      agentPath,
      projectRoot,
      model: activeModelId,
      effort: activeEffort,
      isWin,
    });
    setTimeout(() => {
      terminalRef.current?.sendCommand(cmd);
      terminalRef.current?.focus();
    }, 60);
    setActionNotice(
      `Started ${activeLabel}${activeModelId ? ` (${activeModelId})` : ""} interactively in the terminal (Ronic OS MCP synced).`,
    );
  }

  // Generic smooth pointer-drag resize helper
  function startResize(
    axis: "x" | "y",
    onMove: (delta: number, clientX: number, clientY: number) => void,
  ) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (ev: PointerEvent) => {
        const delta = axis === "x" ? ev.clientX - startX : ev.clientY - startY;
        onMove(delta, ev.clientX, ev.clientY);
      };
      const handlePointerUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    };
  }

  // Live Ronic OS capabilities filtered for active profile
  const profileSkills = useMemo(() => {
    const q = capSearch.trim().toLowerCase();
    return (snap.skills || [])
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .map((s) => ({
        ...s,
        enabled: s.enables?.some((f) => f.profileId === activeProfileId && f.enabled) ?? false,
      }));
  }, [snap.skills, capSearch, activeProfileId]);

  const profilePlugins = useMemo(() => {
    const q = capSearch.trim().toLowerCase();
    return (snap.plugins || [])
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
      .map((p) => ({
        ...p,
        enabled: p.agentEnables?.some((f) => f.profileId === activeProfileId && f.enabled) ?? false,
      }));
  }, [snap.plugins, capSearch, activeProfileId]);

  const profileMcps = useMemo(() => {
    const q = capSearch.trim().toLowerCase();
    return (snap.mcpServers || [])
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.transport.toLowerCase().includes(q))
      .map((m) => ({
        ...m,
        enabled: m.enables?.some((f) => f.profileId === activeProfileId && f.enabled) ?? false,
      }));
  }, [snap.mcpServers, capSearch, activeProfileId]);

  const profileMemories = useMemo(() => {
    const q = capSearch.trim().toLowerCase();
    return (snap.memories || []).filter(
      (m) => !q || m.title.toLowerCase().includes(q) || m.contentMarkdown.toLowerCase().includes(q),
    );
  }, [snap.memories, capSearch]);

  const enabledSkillsCount = useMemo(
    () => (snap.skills || []).filter((s) => s.enables?.some((f) => f.profileId === activeProfileId && f.enabled)).length,
    [snap.skills, activeProfileId],
  );
  const enabledPluginsCount = useMemo(
    () => (snap.plugins || []).filter((p) => p.agentEnables?.some((f) => f.profileId === activeProfileId && f.enabled)).length,
    [snap.plugins, activeProfileId],
  );
  const enabledMcpCount = useMemo(
    () => (snap.mcpServers || []).filter((m) => m.enables?.some((f) => f.profileId === activeProfileId && f.enabled)).length,
    [snap.mcpServers, activeProfileId],
  );

  // Filtered sessions for the History tab
  const visibleSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    const rootKey = normalizeProjectKey(projectRoot);
    return sessions.filter((s) => {
      if (sessionScope === "project" && rootKey && s.projectRoot && normalizeProjectKey(s.projectRoot) !== rootKey) {
        return false;
      }
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.agent.toLowerCase().includes(q) ||
        s.turns.some((t) => t.prompt.toLowerCase().includes(q))
      );
    });
  }, [sessions, sessionSearch, sessionScope, projectRoot]);

  // Recursive file tree renderer
  function renderTreeNodes(dirPath: string, depth: number): React.ReactNode {
    const entries = treeByPath[dirPath] || [];
    const q = fileFilter.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) => e.isDir || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q))
      : entries;

    return filtered.map((entry) => {
      const isExpanded = Boolean(expandedDirs[entry.path]);
      const isSelected = !entry.isDir && openFile?.path === entry.path;
      const isAttached = attachedFiles.includes(entry.path);
      return (
        <div key={entry.path}>
          <div
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            className={`group flex items-center justify-between gap-1 pr-1.5 py-1 rounded-md text-[11px] cursor-pointer transition ${
              isSelected
                ? "bg-slate-900 text-white font-medium"
                : "text-slate-700 hover:bg-slate-100"
            }`}
            onClick={() => (entry.isDir ? void handleToggleDir(entry.path) : void handleOpenFile(entry.path))}
            title={entry.path}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {entry.isDir ? (
                <>
                  {isExpanded ? <ChevronDown size={11} className="shrink-0 opacity-70" /> : <ChevronRight size={11} className="shrink-0 opacity-70" />}
                  {isExpanded ? (
                    <FolderOpen size={12} className="shrink-0 text-amber-500" />
                  ) : (
                    <Folder size={12} className="shrink-0 text-amber-500" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-[11px] shrink-0" />
                  <FileCode size={12} className={`shrink-0 ${isSelected ? "text-blue-300" : "text-slate-400"}`} />
                </>
              )}
              <span className="truncate font-mono">{entry.name}</span>
            </div>
            {!entry.isDir && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    addAttachedFile(entry.path);
                  }}
                  title="Attach @file to agent prompt"
                  className={`px-1 py-0.5 rounded text-[9px] font-mono transition ${
                    isAttached
                      ? "bg-blue-500 text-white"
                      : isSelected
                        ? "opacity-80 hover:bg-white/20 text-white"
                        : "opacity-0 group-hover:opacity-100 bg-slate-200 hover:bg-slate-300 text-slate-700"
                  }`}
                >
                  @
                </button>
              </div>
            )}
          </div>
          {entry.isDir && isExpanded && renderTreeNodes(entry.path, depth + 1)}
        </div>
      );
    });
  }

  // Visible columns in user's dragged pane order
  const visiblePanes = useMemo(() => {
    return layout.paneOrder.filter((p) => {
      if (p === "explorer") return layout.showLeft;
      if (p === "capabilities") return layout.showRight;
      return true;
    });
  }, [layout.paneOrder, layout.showLeft, layout.showRight]);

  function paneDragProps(pane: PaneId) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDraggingPane(pane);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", pane);
      },
      onDragEnd: () => {
        setDraggingPane(null);
        setDragOverPane(null);
      },
    };
  }

  function paneDropProps(pane: PaneId) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!draggingPane || draggingPane === pane) return;
        e.preventDefault();
        if (dragOverPane !== pane) setDragOverPane(pane);
      },
      onDragLeave: () => {
        if (dragOverPane === pane) setDragOverPane(null);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const from = (e.dataTransfer.getData("text/plain") as PaneId) || draggingPane;
        if (from && from !== pane) {
          setLayout((prev) => ({
            ...prev,
            paneOrder: reorderPanes(prev.paneOrder, from, pane),
          }));
        }
        setDraggingPane(null);
        setDragOverPane(null);
      },
    };
  }

  // Render Explorer Pane (Projects + Sessions top, Files + Git Changes bottom, vertically resizable!)
  function renderExplorerPane() {
    const topPct = Math.round(layout.leftTopRatio * 100);
    return (
      <aside
        style={{ width: `${layout.leftWidth}px` }}
        {...paneDropProps("explorer")}
        className={`bg-white flex flex-col shrink-0 overflow-hidden select-none transition-colors ${
          dragOverPane === "explorer" ? "ring-2 ring-inset ring-blue-400" : ""
        }`}
      >
        {/* Draggable Panel Header */}
        <div
          {...paneDragProps("explorer")}
          title="Drag to reorder Explorer column"
          className="h-8 px-2.5 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing"
        >
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <GripVertical size={11} className="text-slate-400" />
            <span>Explorer</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void run("scan_environment")}
              className="text-[10px] font-medium text-blue-600 hover:underline px-1 cursor-pointer"
              title="Scan installed CLIs and IDEs"
            >
              Scan
            </button>
            <button
              type="button"
              onClick={() => setLayout((prev) => ({ ...prev, showLeft: false }))}
              className="p-0.5 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
              title="Hide Explorer"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        <div ref={explorerBodyRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* TOP SECTION: Projects & Sessions */}
        <div style={{ height: `${topPct}%` }} className="flex flex-col min-h-[120px] overflow-hidden">
          <div className="px-2 pt-2 pb-1.5 flex items-center justify-between border-b border-slate-100 shrink-0">
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
              <button
                type="button"
                onClick={() => setLeftTopTab("projects")}
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition cursor-pointer ${
                  leftTopTab === "projects" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Folder size={11} />
                <span>Projects</span>
              </button>
              <button
                type="button"
                onClick={() => setLeftTopTab("sessions")}
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition cursor-pointer ${
                  leftTopTab === "sessions" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <History size={11} />
                <span>Sessions ({sessions.length})</span>
              </button>
            </div>
            {leftTopTab === "projects" ? (
              <button
                type="button"
                onClick={() => void handleAddProject()}
                className="px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 hover:bg-blue-50 rounded flex items-center gap-0.5 cursor-pointer"
                title="Add or switch project folder"
              >
                <Plus size={11} />
                <span>Add</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNewSession}
                className="px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 hover:bg-blue-50 rounded flex items-center gap-0.5 cursor-pointer"
                title="Start new coding session"
              >
                <Plus size={11} />
                <span>New</span>
              </button>
            )}
          </div>

          {leftTopTab === "projects" ? (
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {projects.length === 0 ? (
                <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg text-center space-y-2">
                  <div>No project folder selected.</div>
                  <button
                    type="button"
                    onClick={() => void handleAddProject()}
                    className="px-2.5 py-1 bg-slate-900 text-white rounded-md text-[11px] font-semibold cursor-pointer"
                  >
                    Open Folder
                  </button>
                </div>
              ) : (
                projects.map((proj) => {
                  const isCurrent = normalizeProjectKey(proj.path) === normalizeProjectKey(projectRoot);
                  return (
                    <div
                      key={proj.path}
                      onClick={() => void handleSwitchProject(proj.path)}
                      className={`group p-2 rounded-lg border transition cursor-pointer ${
                        isCurrent
                          ? "border-slate-900 bg-slate-50 shadow-2xs"
                          : "border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50/70"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Folder size={12} className={isCurrent ? "text-blue-600 shrink-0" : "text-slate-400 shrink-0"} />
                          <span className="text-xs font-semibold text-slate-900 truncate">{proj.name}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {isCurrent && gitBranch && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200/70 flex items-center gap-0.5">
                              <GitBranch size={9} />
                              {gitBranch}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              handleCdProjectInTerminal(proj.path);
                            }}
                            title="cd to this project in the embedded terminal"
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-slate-800 rounded cursor-pointer"
                          >
                            <Terminal size={10} />
                          </button>
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setProjects((prev) => togglePinProject(prev, proj.path));
                            }}
                            title={proj.pinned ? "Unpin project" : "Pin project"}
                            className={`p-0.5 rounded cursor-pointer ${
                              proj.pinned ? "text-amber-500" : "opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700"
                            }`}
                          >
                            <Pin size={10} />
                          </button>
                          {!isCurrent && (
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setProjects((prev) => removeProject(prev, proj.path));
                              }}
                              title="Remove from project list"
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
                            >
                              <Trash2 size={10} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5" title={proj.path}>
                        {proj.path}
                      </div>
                    </div>
                  );
                })
              )}
              <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 px-1 pt-1 border-t border-slate-100">
                <span>uv: {detectedPaths.uv ? "Ready" : "Off"}</span>
                <span>bun: {detectedPaths.bun ? "Ready" : "Off"}</span>
                <span>{isGitRepo ? `${files.length} changed` : "No git"}</span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-slate-100 shrink-0">
                <div className="flex-1 relative">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                    placeholder="Filter sessions…"
                    className="w-full pl-6 pr-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md outline-none focus:border-slate-400"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setSessionScope((s) => (s === "project" ? "all" : "project"))}
                  className="px-1.5 py-1 text-[10px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md shrink-0 cursor-pointer"
                  title="Toggle current project vs all sessions"
                >
                  {sessionScope === "project" ? "Project" : "All"}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {visibleSessions.length === 0 ? (
                  <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg text-center">
                    No matching sessions yet.
                  </div>
                ) : (
                  visibleSessions.map((session) => {
                    const isCurrent = session.id === activeSession?.id;
                    const isRenaming = renamingSessionId === session.id;
                    return (
                      <div
                        key={session.id}
                        onClick={() => setActiveSessionId(session.id)}
                        className={`group p-2 rounded-lg border text-xs transition cursor-pointer ${
                          isCurrent
                            ? "border-slate-900 bg-slate-50 shadow-2xs"
                            : "border-slate-200/80 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          {isRenaming ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => {
                                setSessions((prev) => renameSession(prev, session.id, renameDraft));
                                setRenamingSessionId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  setSessions((prev) => renameSession(prev, session.id, renameDraft));
                                  setRenamingSessionId(null);
                                } else if (e.key === "Escape") {
                                  setRenamingSessionId(null);
                                }
                              }}
                              className="flex-1 text-xs font-semibold bg-white border border-blue-400 rounded px-1 py-0.5 outline-none"
                            />
                          ) : (
                            <span className="font-semibold text-slate-900 truncate text-[11px]">{session.title}</span>
                          )}
                          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setRenamingSessionId(session.id);
                                setRenameDraft(session.title);
                              }}
                              className="p-0.5 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                              title="Rename session"
                            >
                              <Pencil size={10} />
                            </button>
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setSessions((prev) => deleteSession(prev, session.id));
                              }}
                              className="p-0.5 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
                              title="Delete session"
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center justify-between mt-1 text-[10px] font-mono text-slate-500">
                          <span>{labelFor(session.agent)}</span>
                          <span>
                            {session.turns.length} turn{session.turns.length === 1 ? "" : "s"} · {formatTimeAgo(session.updatedAt)}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* DRAGGABLE HORIZONTAL SPLITTER INSIDE EXPLORER */}
        <div
          onPointerDown={startResize("y", (_delta, _cx, clientY) => {
            if (!explorerBodyRef.current) return;
            const rect = explorerBodyRef.current.getBoundingClientRect();
            const ratio = (clientY - rect.top) / Math.max(200, rect.height);
            setLayout((prev) => clampLayout({ ...prev, leftTopRatio: ratio }));
          })}
          onDoubleClick={() => setLayout((prev) => ({ ...prev, leftTopRatio: DEFAULT_LAYOUT.leftTopRatio }))}
          title="Drag to resize Projects/Sessions vs Files/Changes (double-click to reset)"
          className="h-1.5 bg-slate-100 hover:bg-blue-400/70 border-y border-slate-200 cursor-row-resize shrink-0 transition-colors"
        />

        {/* BOTTOM SECTION: Project Files Tree & Git Changes */}
        <div className="flex-1 min-h-[140px] flex flex-col overflow-hidden">
          <div className="px-2 pt-2 pb-1.5 flex items-center justify-between border-b border-slate-100 shrink-0">
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
              <button
                type="button"
                onClick={() => setLeftBottomTab("files")}
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition cursor-pointer ${
                  leftBottomTab === "files" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <FileText size={11} />
                <span>Files</span>
              </button>
              <button
                type="button"
                onClick={() => setLeftBottomTab("changes")}
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition cursor-pointer ${
                  leftBottomTab === "changes" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <GitBranch size={11} className="text-emerald-600" />
                <span>Changes ({files.length})</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                if (leftBottomTab === "files") {
                  setTreeByPath({});
                  void loadDirectory("");
                } else {
                  void refreshGitStatus();
                }
              }}
              disabled={isScanningGit || loadingTree}
              className="p-1 text-slate-500 hover:text-blue-600 rounded cursor-pointer"
              title="Refresh"
            >
              <RefreshCw size={11} className={isScanningGit || loadingTree ? "spin" : ""} />
            </button>
          </div>

          {leftBottomTab === "files" ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-2 py-1.5 border-b border-slate-100 shrink-0 space-y-1.5">
                <div className="flex items-center gap-1">
                  <div className="relative flex-1">
                    <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={fileFilter}
                      onChange={(e) => setFileFilter(e.target.value)}
                      placeholder="Filter project files…"
                      className="w-full pl-6 pr-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md outline-none focus:border-slate-400"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreatingFile((v) => !v)}
                    title="Create new file in project"
                    className="p-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 cursor-pointer shrink-0"
                  >
                    <Plus size={11} />
                  </button>
                </div>
                {creatingFile && (
                  <div className="flex items-center gap-1">
                    <input
                      autoFocus
                      type="text"
                      value={newFilePath}
                      onChange={(e) => setNewFilePath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleCreateNewFile();
                        else if (e.key === "Escape") setCreatingFile(false);
                      }}
                      placeholder="path/to/new-file.ts"
                      className="flex-1 px-2 py-1 text-[10px] font-mono bg-white border border-blue-400 rounded-md outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreateNewFile()}
                      disabled={!newFilePath.trim()}
                      className="px-2 py-1 text-[10px] font-semibold bg-slate-900 disabled:bg-slate-300 text-white rounded-md cursor-pointer"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                {loadingTree && !(treeByPath[""]?.length) ? (
                  <div className="p-3 text-[11px] text-slate-500">Scanning project files…</div>
                ) : (treeByPath[""]?.length || 0) === 0 ? (
                  <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg">
                    {projectRoot ? "No files listed in this folder." : "Pick a project folder to browse files."}
                  </div>
                ) : (
                  renderTreeNodes("", 0)
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                {!isGitRepo ? (
                  <div className="p-3 text-[11px] text-slate-600 border border-dashed border-slate-200 rounded-lg space-y-2">
                    <div>This project folder is not a git repository yet.</div>
                    <button
                      type="button"
                      onClick={() => void handleGitAction("git_init")}
                      className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-md text-[11px] font-semibold cursor-pointer"
                    >
                      Initialize Git
                    </button>
                  </div>
                ) : files.length === 0 ? (
                  <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg">
                    {treeNote || "No uncommitted changes."}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-1 pb-1">
                      <span className="text-[10px] font-mono text-slate-500">
                        {gitBranch ? `branch: ${gitBranch}` : "git working tree"}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleGitAction("stage_all")}
                        className="text-[10px] font-semibold text-emerald-700 hover:underline cursor-pointer"
                      >
                        Stage All
                      </button>
                    </div>
                    {files.map((file, idx) => {
                      const isSelected = idx === selectedFileIndex;
                      const filename = file.path.split(/[/\\]/).pop() || file.path;
                      return (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => {
                            setSelectedFileIndex(idx);
                            setCodeTab("diff");
                            if (layout.centerMode === "chat") {
                              setLayout((prev) => ({ ...prev, centerMode: "split" }));
                            }
                          }}
                          className={`w-full text-left p-2 rounded-lg border text-xs transition flex items-center justify-between gap-2 cursor-pointer ${
                            isSelected ? "border-slate-900 bg-slate-50 shadow-2xs" : "border-slate-200 bg-white hover:bg-slate-50"
                          }`}
                        >
                          <div className="truncate min-w-0">
                            <div className="font-mono font-semibold text-slate-900 truncate text-[11px] flex items-center gap-1.5">
                              <span>{filename}</span>
                              {file.staged && (
                                <span className="text-[9px] px-1 py-0.2 bg-emerald-100 text-emerald-700 rounded">S</span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">{file.path}</div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 text-[10px] font-mono font-bold">
                            <span className="text-emerald-600">+{file.additions}</span>
                            <span className="text-rose-600">-{file.deletions}</span>
                          </div>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
              {isGitRepo && files.length > 0 && (
                <div className="p-2 border-t border-slate-100 bg-slate-50/70 flex items-center gap-1.5 shrink-0">
                  <input
                    type="text"
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && commitMsg.trim()) {
                        void handleGitAction("commit", "", commitMsg);
                      }
                    }}
                    placeholder="Commit staged changes…"
                    className="flex-1 px-2 py-1 text-[11px] bg-white border border-slate-200 rounded-md outline-none focus:border-slate-400"
                  />
                  <button
                    type="button"
                    disabled={!commitMsg.trim()}
                    onClick={() => void handleGitAction("commit", "", commitMsg)}
                    className="px-2 py-1 text-[11px] font-semibold bg-slate-900 disabled:bg-slate-300 text-white rounded-md flex items-center gap-1 cursor-pointer"
                    title="Commit staged changes"
                  >
                    <GitCommit size={11} />
                    <span>Commit</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        </div>
      </aside>
    );
  }

  // Render Center Workspace Pane (Session Chat + File/Diff Viewer, resizable split!)
  function renderWorkspacePane() {
    const showChat = layout.centerMode === "chat" || layout.centerMode === "split";
    const showCode = layout.centerMode === "code" || layout.centerMode === "split";
    const chatWidthPct = Math.round(layout.centerSplitRatio * 100);

    return (
      <section
        ref={workspaceRef}
        {...paneDropProps("workspace")}
        className={`flex-1 min-w-[320px] flex flex-col overflow-hidden bg-[#f8fafc] transition-colors ${
          dragOverPane === "workspace" ? "ring-2 ring-inset ring-blue-400" : ""
        }`}
      >
        {/* Draggable Workspace Bar */}
        <div
          {...paneDragProps("workspace")}
          title="Drag to reorder Workspace column"
          className="h-8 px-3 bg-white border-b border-slate-200/80 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing"
        >
          <div className="flex items-center gap-2 min-w-0">
            <GripVertical size={11} className="text-slate-400 shrink-0" />
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-md">
              {(["chat", "split", "code"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setLayout((prev) => ({ ...prev, centerMode: mode }))}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold capitalize transition cursor-pointer ${
                    layout.centerMode === mode ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {mode === "chat" ? "Session Chat" : mode === "split" ? "Split View" : "Files & Diff"}
                </button>
              ))}
            </div>
            {activeSession && (
              <span className="text-[11px] font-medium text-slate-500 truncate hidden md:inline">
                {activeSession.title}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleNewSession}
              className="px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
            >
              + Session
            </button>
          </div>
        </div>

        {/* Workspace Body: Chat + Optional Draggable Split + File/Diff Viewer */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {showChat && (
            <div
              style={showCode ? { width: `${chatWidthPct}%` } : undefined}
              className={`${showCode ? "shrink-0" : "flex-1"} flex flex-col min-w-[240px] bg-white overflow-hidden`}
            >
              {/* Conversation History */}
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3 select-text">
                {!activeSession || activeSession.turns.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500 space-y-2.5">
                    <div className="w-10 h-10 rounded-2xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700">
                      <MessageSquare size={18} />
                    </div>
                    <div className="text-sm font-semibold text-slate-800">
                      {activeLabel} is wired to Ronic OS
                    </div>
                    <p className="text-xs text-slate-500 max-w-sm leading-relaxed">
                      Selecting any coding agent automatically syncs Ronic OS skills ({enabledSkillsCount}), plugins ({enabledPluginsCount}), MCP servers ({enabledMcpCount + (syncReport?.bridgeOnline ? 1 : 0)}), and memory.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
                      {[
                        "Inspect project structure and summarize architecture",
                        "Check available Ronic OS skills, plugins, and MCP tools",
                        "Review uncommitted changes and run project tests",
                      ].map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => setTaskPrompt(suggestion)}
                          className="px-2.5 py-1 text-[11px] bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-full text-slate-700 transition cursor-pointer"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  activeSession.turns.map((turn) => (
                    <div key={turn.id} className="space-y-2">
                      {/* User Prompt Bubble */}
                      <div className="bg-slate-900 text-white rounded-xl p-3 shadow-2xs">
                        <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400 font-mono mb-1">
                          <span className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-white/10 text-white font-semibold">
                              {labelFor(turn.agent)}
                            </span>
                            {turn.model && (
                              <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200 font-medium">
                                {turn.model}
                              </span>
                            )}
                            <span>{formatTimeAgo(turn.createdAt)}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleDispatch(turn.prompt)}
                            disabled={isDispatching || !agentReady}
                            className="text-slate-300 hover:text-white flex items-center gap-1 cursor-pointer"
                            title="Re-run this prompt"
                          >
                            <RotateCcw size={10} />
                            <span>Re-run</span>
                          </button>
                        </div>
                        <div className="text-xs leading-relaxed whitespace-pre-wrap">{turn.prompt}</div>
                        {(turn.attachedFiles.length > 0 || turn.selectedSkills.length > 0) && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {turn.attachedFiles.map((f) => (
                              <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200">
                                @{f}
                              </span>
                            ))}
                            {turn.selectedSkills.map((sk) => (
                              <span key={sk} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">
                                /{sk}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Agent Response Card */}
                      <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
                        <div className="px-3 py-1.5 bg-white border-b border-slate-200/80 flex items-center justify-between text-[10px] font-mono text-slate-500">
                          <div className="flex items-center gap-2">
                            <span
                              className={`px-1.5 py-0.5 rounded font-semibold ${
                                turn.exitCode === 0 || turn.exitCode === null
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-rose-50 text-rose-700"
                              }`}
                            >
                              {turn.exitCode === null ? "Launched" : turn.exitCode === 0 ? "Exit 0" : `Exit ${turn.exitCode}`}
                            </span>
                            <span>{(turn.durationMs / 1000).toFixed(1)}s</span>
                            {turn.changedFiles.length > 0 && (
                              <span className="text-blue-600">{turn.changedFiles.length} file(s) changed</span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(turn.output);
                              setToast("Copied agent output.");
                            }}
                            className="text-slate-400 hover:text-slate-800 flex items-center gap-1 cursor-pointer"
                          >
                            <Copy size={10} />
                            <span>Copy</span>
                          </button>
                        </div>
                        <pre className="p-3 text-[11px] font-mono text-slate-800 whitespace-pre-wrap leading-relaxed max-h-72 overflow-auto">
                          {turn.output}
                        </pre>
                      </div>
                    </div>
                  ))
                )}
                {isDispatching && (
                  <div className="space-y-2">
                    {streamingPrompt && (
                      <div className="bg-slate-900 text-white rounded-xl p-3 shadow-2xs">
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono mb-1">
                          <span className="px-1.5 py-0.5 rounded bg-white/10 text-white font-semibold">{activeLabel}</span>
                          {activeModelId && (
                            <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200">{activeModelId}</span>
                          )}
                          <span>just now</span>
                        </div>
                        <div className="text-xs leading-relaxed whitespace-pre-wrap">{streamingPrompt}</div>
                      </div>
                    )}
                    <div className="rounded-xl border border-blue-200 bg-blue-50/40 overflow-hidden">
                      <div className="px-3 py-1.5 bg-blue-50/80 border-b border-blue-200/70 flex items-center justify-between text-[10px] font-mono text-blue-800">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span>
                            {streamingOutput
                              ? `${activeLabel} streaming…`
                              : `Waiting for ${activeLabel}${activeModelId ? ` (${activeModelId})` : ""}…`}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 text-blue-700">
                          {firstByteMs !== null && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                              first byte {(firstByteMs / 1000).toFixed(1)}s
                            </span>
                          )}
                          <span>{elapsedSec.toFixed(1)}s</span>
                          <button
                            type="button"
                            onClick={() => void handleCancelDispatch()}
                            className="px-1.5 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-semibold flex items-center gap-1 cursor-pointer"
                            title="Stop the running coding agent"
                          >
                            <Square size={8} className="fill-current" />
                            <span>Stop</span>
                          </button>
                        </span>
                      </div>
                      {streamingOutput && (
                        <pre className="p-3 text-[11px] font-mono text-slate-800 whitespace-pre-wrap leading-relaxed max-h-72 overflow-auto">
                          {streamingOutput}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Composer Area */}
              <div className="p-3 border-t border-slate-200 bg-slate-50/80 space-y-2 shrink-0">
                {/* Direct Model Switcher + Reasoning Effort Row */}
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div ref={modelPickerRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setModelPickerOpen((o) => !o)}
                      title="Switch model directly for this coding agent"
                      className="px-2 py-1 rounded-lg bg-white border border-slate-300 hover:border-slate-900 text-[11px] font-semibold text-slate-800 flex items-center gap-1.5 shadow-2xs transition cursor-pointer max-w-[230px]"
                    >
                      <Cpu size={11} className="text-blue-600 shrink-0" />
                      <span className="truncate font-mono text-[10px]">
                        {activeModelObj?.label || activeModelId || "Default Model"}
                      </span>
                      {activeModelObj?.tier === "fast" && (
                        <span className="px-1 py-0.2 rounded bg-emerald-100 text-emerald-700 text-[9px] font-bold shrink-0">
                          Fast
                        </span>
                      )}
                      <ChevronDown size={11} className="text-slate-400 shrink-0" />
                    </button>

                    {modelPickerOpen && (
                      <div className="absolute bottom-full left-0 mb-1.5 w-80 max-h-80 bg-white border border-slate-200 rounded-xl shadow-xl z-50 flex flex-col overflow-hidden">
                        <div className="p-2 border-b border-slate-100 flex items-center gap-1.5 bg-slate-50/70">
                          <div className="relative flex-1">
                            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                              type="text"
                              autoFocus
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              placeholder={`Search ${activeLabel} models…`}
                              className="w-full pl-6 pr-2 py-1 text-[11px] bg-white border border-slate-200 rounded-md outline-none focus:border-slate-400"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => void loadModelsForHarness(activeAgent, true)}
                            disabled={loadingModels}
                            title="Refresh live models from CLI"
                            className="p-1.5 rounded-md bg-white border border-slate-200 text-slate-500 hover:text-blue-600 cursor-pointer"
                          >
                            <RefreshCw size={11} className={loadingModels ? "spin" : ""} />
                          </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                          <button
                            type="button"
                            onClick={() => handleSelectModel("")}
                            className={`w-full text-left px-2 py-1.5 rounded-lg text-[11px] flex items-center justify-between transition cursor-pointer ${
                              !activeModelId ? "bg-slate-900 text-white font-semibold" : "text-slate-700 hover:bg-slate-100"
                            }`}
                          >
                            <span>Harness Default (Auto)</span>
                            {!activeModelId && <Check size={11} />}
                          </button>

                          {availableModels
                            .filter((m) => {
                              const q = modelSearch.trim().toLowerCase();
                              return !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q);
                            })
                            .map((m) => {
                              const isPicked = activeModelId === m.id;
                              return (
                                <button
                                  key={`${m.source}:${m.id}`}
                                  type="button"
                                  onClick={() => handleSelectModel(m.id)}
                                  className={`w-full text-left px-2 py-1.5 rounded-lg text-[11px] flex items-center justify-between gap-2 transition cursor-pointer ${
                                    isPicked ? "bg-slate-900 text-white font-semibold" : "text-slate-700 hover:bg-slate-100"
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <div className="truncate">{m.label}</div>
                                    <div className={`text-[9px] font-mono truncate ${isPicked ? "text-slate-300" : "text-slate-400"}`}>
                                      {m.id}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <span
                                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                                        m.tier === "fast"
                                          ? isPicked
                                            ? "bg-emerald-500/30 text-emerald-200"
                                            : "bg-emerald-50 text-emerald-700"
                                          : m.tier === "deep"
                                            ? isPicked
                                              ? "bg-purple-500/30 text-purple-200"
                                              : "bg-purple-50 text-purple-700"
                                            : isPicked
                                              ? "bg-white/15 text-slate-200"
                                              : "bg-slate-100 text-slate-600"
                                      }`}
                                    >
                                      {m.tier === "fast" ? "Fast" : m.tier === "deep" ? "Deep" : "Balanced"}
                                    </span>
                                    {isPicked && <Check size={11} />}
                                  </div>
                                </button>
                              );
                            })}
                        </div>

                        <div className="p-2 border-t border-slate-100 bg-slate-50/80 flex items-center gap-1.5">
                          <input
                            type="text"
                            value={customModelDraft}
                            onChange={(e) => setCustomModelDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleAddCustomModel();
                              }
                            }}
                            placeholder="Custom model ID (e.g. sonnet, o4-mini)…"
                            className="flex-1 px-2 py-1 text-[10px] font-mono bg-white border border-slate-200 rounded-md outline-none focus:border-slate-400"
                          />
                          <button
                            type="button"
                            onClick={handleAddCustomModel}
                            disabled={!customModelDraft.trim()}
                            className="px-2 py-1 text-[10px] font-semibold bg-slate-900 disabled:bg-slate-300 text-white rounded-md cursor-pointer"
                          >
                            Use
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Quick Effort Pills for Speed vs Depth */}
                  <div className="flex items-center gap-0.5 bg-white border border-slate-200 rounded-lg p-0.5 text-[10px]">
                    {(
                      [
                        ["auto", "Auto"],
                        ["low", "Fast"],
                        ["medium", "Med"],
                        ["high", "High"],
                      ] as const
                    ).map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => handleSelectEffort(id)}
                        title={`Reasoning effort: ${lbl}`}
                        className={`px-1.5 py-0.5 rounded font-semibold transition cursor-pointer ${
                          activeEffort === id
                            ? id === "low"
                              ? "bg-emerald-600 text-white"
                              : "bg-slate-900 text-white"
                            : "text-slate-500 hover:text-slate-900"
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Auto-Capability, Speed & Permission Toggles */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <label
                      className="flex items-center gap-1 cursor-pointer text-slate-700 font-medium"
                      title="Compact MCP prompt (~450 chars) for faster first-token speed instead of dumping full inline lists"
                    >
                      <input
                        type="checkbox"
                        checked={fastContext}
                        onChange={(e) => setFastContext(e.target.checked)}
                        className="accent-emerald-600 rounded"
                      />
                      <Zap size={10} className="text-emerald-600" />
                      <span>Fast Mode</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer text-slate-700 font-medium">
                      <input
                        type="checkbox"
                        checked={injectContext}
                        onChange={(e) => setInjectContext(e.target.checked)}
                        className="accent-slate-900 rounded"
                      />
                      <span>Ronic Context</span>
                    </label>
                    <label
                      className="flex items-center gap-1 cursor-pointer text-slate-700 font-medium"
                      title="Auto-approve tool permissions in headless CLI dispatch (prevents permission auto-deny errors)"
                    >
                      <input
                        type="checkbox"
                        checked={autoApprove}
                        onChange={(e) => setAutoApprove(e.target.checked)}
                        className="accent-slate-900 rounded"
                      />
                      <span>Auto-approve</span>
                    </label>
                  </div>
                  <span className={`font-mono ${agentReady ? "text-emerald-600" : "text-slate-400"}`}>
                    {agentReady ? "Ready" : "Not linked"}
                  </span>
                </div>

                {/* Attached @files and /skills pills */}
                {(attachedFiles.length > 0 || selectedSkills.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {attachedFiles.map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-blue-50 border border-blue-200 text-[10px] font-mono text-blue-700"
                      >
                        @{f}
                        <button
                          type="button"
                          onClick={() => setAttachedFiles((prev) => prev.filter((x) => x !== f))}
                          className="hover:text-blue-950 cursor-pointer"
                        >
                          <X size={9} />
                        </button>
                      </span>
                    ))}
                    {selectedSkills.map((sk) => (
                      <span
                        key={sk}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-mono text-emerald-700"
                      >
                        /{sk}
                        <button
                          type="button"
                          onClick={() => toggleSelectedSkill(sk)}
                          className="hover:text-emerald-950 cursor-pointer"
                        >
                          <X size={9} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <textarea
                  id="agent-task-input"
                  rows={3}
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void handleDispatch();
                    }
                  }}
                  placeholder={
                    agentReady
                      ? `Assign task to ${activeLabel}… (Ctrl+Enter to run)`
                      : `Link ${activeLabel} before dispatching a task.`
                  }
                  className="w-full p-2.5 text-xs font-sans border border-slate-300 rounded-xl outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900 bg-white text-slate-900 placeholder-slate-400 resize-none"
                />

                <div className="flex items-center gap-2">
                  {isDispatching ? (
                    <button
                      type="button"
                      onClick={() => void handleCancelDispatch()}
                      className="flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer bg-rose-600 hover:bg-rose-700 text-white shadow-2xs"
                    >
                      <Square size={11} className="fill-current" />
                      <span>Stop {activeLabel} ({elapsedSec.toFixed(1)}s)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleDispatch()}
                      disabled={!taskPrompt.trim() || !agentReady}
                      className={`flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
                        !taskPrompt.trim() || !agentReady
                          ? "bg-slate-400 text-white cursor-not-allowed"
                          : "bg-slate-900 text-white hover:bg-slate-800 shadow-2xs"
                      }`}
                    >
                      <Play size={12} className="fill-current" />
                      <span>Run {activeLabel}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleLaunchInteractiveInTerminal}
                    disabled={!agentReady}
                    title={`Launch ${activeLabel} interactively inside the project terminal`}
                    className="px-2.5 py-2 text-xs font-semibold bg-white border border-slate-300 hover:border-slate-900 disabled:opacity-50 text-slate-700 rounded-lg flex items-center gap-1 transition cursor-pointer shrink-0"
                  >
                    <Terminal size={12} />
                    <span className="hidden sm:inline">Interactive</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* DRAGGABLE VERTICAL SPLITTER INSIDE CENTER WORKSPACE (CHAT <-> FILE/DIFF) */}
          {showChat && showCode && (
            <div
              onPointerDown={startResize("x", (_delta, clientX) => {
                if (!workspaceRef.current) return;
                const rect = workspaceRef.current.getBoundingClientRect();
                const ratio = (clientX - rect.left) / Math.max(320, rect.width);
                setLayout((prev) => clampLayout({ ...prev, centerSplitRatio: ratio }));
              })}
              onDoubleClick={() => setLayout((prev) => ({ ...prev, centerSplitRatio: DEFAULT_LAYOUT.centerSplitRatio }))}
              title="Drag to resize Chat vs File/Diff view (double-click to reset)"
              className="w-1.5 bg-slate-100 hover:bg-blue-400/70 border-x border-slate-200 cursor-col-resize shrink-0 transition-colors"
            />
          )}

          {showCode && (
            <div className="flex-1 min-w-[240px] flex flex-col overflow-hidden bg-[#f8fafc]">
              {/* Code / Diff Subheader */}
              <div className="h-9 px-3 bg-white border-b border-slate-200/80 flex items-center justify-between shrink-0 gap-2">
                <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-md">
                  <button
                    type="button"
                    onClick={() => setCodeTab("file")}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer ${
                      codeTab === "file" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    <Code2 size={11} />
                    <span>File View</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCodeTab("diff")}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer ${
                      codeTab === "diff" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    <GitBranch size={11} />
                    <span>Git Diff ({files.length})</span>
                  </button>
                </div>
                {codeTab === "file" && openFile && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => addAttachedFile(openFile.path)}
                      className="px-2 py-0.5 text-[10px] font-semibold bg-blue-50 hover:bg-blue-100 text-blue-700 rounded cursor-pointer"
                    >
                      +@ Prompt
                    </button>
                    {!openFile.binary && !openFile.truncated && !isEditingFile && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditDraft(openFile.content);
                          setIsEditingFile(true);
                        }}
                        className="px-2 py-0.5 text-[10px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded flex items-center gap-1 cursor-pointer"
                      >
                        <Pencil size={10} />
                        <span>Edit</span>
                      </button>
                    )}
                    {isEditingFile && (
                      <>
                        <button
                          type="button"
                          disabled={savingFile}
                          onClick={() => void handleSaveOpenFile()}
                          className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded flex items-center gap-1 cursor-pointer"
                        >
                          <Save size={10} />
                          <span>{savingFile ? "Saving…" : "Save"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsEditingFile(false)}
                          className="px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-600 rounded cursor-pointer"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* File Viewer or Git Diff Viewer */}
              <div className="flex-1 overflow-auto p-3 select-text">
                {codeTab === "file" ? (
                  loadingFile ? (
                    <div className="p-4 text-xs text-slate-500">Loading file…</div>
                  ) : openFile ? (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs flex flex-col h-full">
                      <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-[11px] font-mono text-slate-600 shrink-0">
                        <span className="font-semibold text-slate-900 truncate">{openFile.path}</span>
                        <span className="shrink-0 text-[10px] text-slate-500">
                          {openFile.lines} lines · {formatBytes(openFile.size)}
                        </span>
                      </div>
                      {isEditingFile ? (
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          spellCheck={false}
                          className="flex-1 w-full p-3 font-mono text-xs text-slate-900 bg-white outline-none resize-none leading-relaxed"
                        />
                      ) : (
                        <pre className="flex-1 p-3 font-mono text-[11px] leading-relaxed overflow-auto text-slate-800">
                          {openFile.content.split("\n").map((line, i) => (
                            <div key={i} className="flex">
                              <span className="w-9 pr-3 text-right text-slate-400 select-none shrink-0">{i + 1}</span>
                              <span className="whitespace-pre">{line || " "}</span>
                            </div>
                          ))}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <div className="p-6 text-xs text-slate-500 bg-white border border-slate-200 rounded-xl text-center">
                      Select any file in the Explorer Files tree to view or edit it here.
                    </div>
                  )
                ) : activeFile ? (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between bg-white border border-slate-200 p-2.5 rounded-xl shadow-2xs gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-xs font-bold text-slate-900 truncate">{activeFile.path}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded font-medium">
                          +{activeFile.additions} -{activeFile.deletions}
                        </span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-semibold ${
                            activeFile.staged ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                          }`}
                        >
                          {activeFile.staged ? "Staged" : "Working tree"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleGitAction(activeFile.staged ? "unstage" : "stage", activeFile.path)}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1 cursor-pointer"
                        >
                          <Check size={12} />
                          <span>{activeFile.staged ? "Unstage" : "Stage"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleGitAction("restore", activeFile.path)}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-white border border-slate-200 hover:border-rose-500 text-rose-600 rounded-lg flex items-center gap-1 cursor-pointer"
                        >
                          <X size={12} />
                          <span>Restore</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            addAttachedFile(activeFile.path);
                            setTaskPrompt(`Refine the changes in ${activeFile.path}.`);
                          }}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg cursor-pointer"
                        >
                          Refine
                        </button>
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden font-mono text-[11px] shadow-2xs">
                      <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 text-[10px] font-bold text-slate-500">
                        git diff
                      </div>
                      <pre className="p-3 whitespace-pre-wrap leading-relaxed overflow-x-auto">
                        {activeFile.diff.split("\n").map((line, idx) => {
                          const color =
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "text-[#166534] bg-[#f0fdf4]"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "text-[#9f1239] bg-[#fff1f2]"
                                : "text-slate-700";
                          return (
                            <div key={idx} className={color}>
                              {line || " "}
                            </div>
                          );
                        })}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="p-6 text-xs text-slate-500 bg-white border border-slate-200 rounded-xl text-center">
                    {treeNote || "No diff to show. Refresh after changing a file."}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }

  // Render Right Capabilities Bridge Pane (Automatic Skills, Plugins, MCP Servers, Memory)
  function renderCapabilitiesPane() {
    return (
      <aside
        style={{ width: `${layout.rightWidth}px` }}
        {...paneDropProps("capabilities")}
        className={`bg-white flex flex-col shrink-0 overflow-hidden select-none transition-colors ${
          dragOverPane === "capabilities" ? "ring-2 ring-inset ring-blue-400" : ""
        }`}
      >
        {/* Draggable Panel Header */}
        <div
          {...paneDragProps("capabilities")}
          title="Drag to reorder Capabilities column"
          className="h-8 px-2.5 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing"
        >
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <GripVertical size={11} className="text-slate-400" />
            <span>Ronic Bridge</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void syncHarnessNow(activeAgent, false)}
              disabled={isSyncingHarness}
              className="text-[10px] font-semibold text-blue-600 hover:underline flex items-center gap-1 px-1 cursor-pointer"
              title="Re-sync skills, plugins, and MCP servers to active harness"
            >
              <RefreshCw size={10} className={isSyncingHarness ? "spin" : ""} />
              <span>Sync</span>
            </button>
            <button
              type="button"
              onClick={() => setLayout((prev) => ({ ...prev, showRight: false }))}
              className="p-0.5 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
              title="Hide Capabilities Panel"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        {/* Live Automatic Sync Status Card */}
        <div className="p-2.5 border-b border-slate-200 bg-slate-50/70 space-y-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  syncReport?.bridgeOnline ? "bg-emerald-500" : "bg-amber-400"
                }`}
              />
              <span className="text-xs font-bold text-slate-900 truncate">{activeLabel}</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200/70 shrink-0">
              Auto-Wired
            </span>
          </div>

          <div className="grid grid-cols-4 gap-1 text-center">
            <div className="bg-white border border-slate-200/80 rounded-lg py-1">
              <div className="text-xs font-bold text-slate-900">{syncReport?.skillsCount ?? enabledSkillsCount}</div>
              <div className="text-[9px] text-slate-500">Skills</div>
            </div>
            <div className="bg-white border border-slate-200/80 rounded-lg py-1">
              <div className="text-xs font-bold text-slate-900">{syncReport?.pluginsCount ?? enabledPluginsCount}</div>
              <div className="text-[9px] text-slate-500">Plugins</div>
            </div>
            <div className="bg-white border border-slate-200/80 rounded-lg py-1">
              <div className="text-xs font-bold text-slate-900">
                {syncReport?.mcpCount ?? enabledMcpCount + 1}
              </div>
              <div className="text-[9px] text-slate-500">MCPs</div>
            </div>
            <div className="bg-white border border-slate-200/80 rounded-lg py-1">
              <div className="text-xs font-bold text-slate-900">{syncReport?.memoryCount ?? (snap.memories?.length || 0)}</div>
              <div className="text-[9px] text-slate-500">Memory</div>
            </div>
          </div>

          {syncReport?.bridgeEndpoint && (
            <div className="text-[10px] font-mono text-slate-500 truncate" title={syncReport.bridgeEndpoint}>
              MCP: {syncReport.bridgeEndpoint}
            </div>
          )}
          {syncReport && syncReport.configTargets.length > 0 && (
            <div className="text-[10px] text-emerald-700 bg-emerald-50/70 border border-emerald-200/60 rounded-md px-2 py-1 truncate" title={syncReport.configTargets.join("\n")}>
              <ShieldCheck size={10} className="inline mr-1" />
              {syncReport.configTargets[0]}
            </div>
          )}
          {syncReport && syncReport.warnings.length > 0 && (
            <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              {syncReport.warnings[0]}
            </div>
          )}
        </div>

        {/* Capability Sub-Tabs */}
        <div className="px-2 pt-2 pb-1.5 border-b border-slate-100 space-y-1.5 shrink-0">
          <div className="grid grid-cols-4 gap-1 bg-slate-100 p-0.5 rounded-lg">
            {(
              [
                ["skills", "Skills", Wand2],
                ["plugins", "Plugins", Plug],
                ["mcp", "MCP", Server],
                ["memory", "Memory", Database],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setCapTab(id)}
                className={`py-1 rounded-md text-[10px] font-semibold flex items-center justify-center gap-1 transition cursor-pointer ${
                  capTab === id ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Icon size={10} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={capSearch}
              onChange={(e) => setCapSearch(e.target.value)}
              placeholder={`Search ${capTab}…`}
              className="w-full pl-6 pr-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md outline-none focus:border-slate-400"
            />
          </div>
        </div>

        {/* Capability List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {capTab === "skills" &&
            (profileSkills.length === 0 ? (
              <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg text-center space-y-1.5">
                <div>No skills found.</div>
                <button
                  type="button"
                  onClick={() => go("skills")}
                  className="text-blue-600 font-semibold hover:underline cursor-pointer"
                >
                  Open Skills &amp; Capabilities
                </button>
              </div>
            ) : (
              profileSkills.map((skill) => {
                const isPicked = selectedSkills.includes(skill.slug);
                return (
                  <div
                    key={skill.id}
                    className="p-2 rounded-lg border border-slate-200/80 bg-white hover:border-slate-300 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[11px] font-semibold text-slate-900 truncate">{skill.title}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => toggleSelectedSkill(skill.slug)}
                          title="Inject this skill's playbook into next task"
                          className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold cursor-pointer ${
                            isPicked
                              ? "bg-emerald-600 text-white"
                              : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                          }`}
                        >
                          {isPicked ? "Active" : "+Use"}
                        </button>
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          onChange={() => {
                            void run("toggle_skill", {
                              id: skill.id,
                              profileId: activeProfileId,
                              enabled: !skill.enabled,
                            }).then(() => void syncHarnessNow(activeAgent, true));
                          }}
                          className="accent-slate-900 cursor-pointer"
                          title="Enable or disable skill for coding agents"
                        />
                      </div>
                    </div>
                    <div className="text-[10px] font-mono text-blue-600">{skill.slashCommand}</div>
                    {skill.description && (
                      <div className="text-[10px] text-slate-500 line-clamp-2">{skill.description}</div>
                    )}
                  </div>
                );
              })
            ))}

          {capTab === "plugins" &&
            (profilePlugins.length === 0 ? (
              <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg text-center space-y-1.5">
                <div>No plugins installed yet.</div>
                <button
                  type="button"
                  onClick={() => go("skills")}
                  className="text-blue-600 font-semibold hover:underline cursor-pointer"
                >
                  Install Plugins
                </button>
              </div>
            ) : (
              profilePlugins.map((plugin) => (
                <div key={plugin.id} className="p-2 rounded-lg border border-slate-200/80 bg-white space-y-1">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-[11px] font-semibold text-slate-900 truncate">
                      {plugin.name} <span className="text-[10px] font-mono text-slate-400">v{plugin.version}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      onChange={() => {
                        void run("toggle_plugin_agent", {
                          id: plugin.id,
                          profileId: activeProfileId,
                          enabled: !plugin.enabled,
                        }).then(() => void syncHarnessNow(activeAgent, true));
                      }}
                      className="accent-slate-900 cursor-pointer"
                      title="Enable plugin for coding agents"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
                    <span>{plugin.bundledSkills.length} skills</span>
                    <span>·</span>
                    <span>{plugin.tools.length} tools</span>
                    <span>·</span>
                    <span>{plugin.trust}</span>
                  </div>
                </div>
              ))
            ))}

          {capTab === "mcp" && (
            <>
              {/* Always-on Ronic OS Core MCP Server */}
              <div className="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/50 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-emerald-900">ronic-os (Built-in MCP)</span>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-600 text-white">
                    {syncReport?.bridgeOnline ? "Online" : "Ready"}
                  </span>
                </div>
                <div className="text-[10px] text-emerald-800 leading-snug">
                  Exposes skills, plugins, memory, files, and workspace tools directly to {activeLabel}.
                </div>
              </div>

              {profileMcps.length === 0 ? (
                <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg text-center space-y-1.5">
                  <div>No extra external MCP servers configured.</div>
                  <button
                    type="button"
                    onClick={() => go("mesh")}
                    className="text-blue-600 font-semibold hover:underline cursor-pointer"
                  >
                    Connect MCP Servers
                  </button>
                </div>
              ) : (
                profileMcps.map((srv) => (
                  <div key={srv.id} className="p-2 rounded-lg border border-slate-200/80 bg-white space-y-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[11px] font-semibold text-slate-900 truncate">{srv.name}</span>
                      <input
                        type="checkbox"
                        checked={srv.enabled}
                        onChange={() => {
                          void run("toggle_mcp", {
                            id: srv.id,
                            profileId: activeProfileId,
                            enabled: !srv.enabled,
                          }).then(() => void syncHarnessNow(activeAgent, true));
                        }}
                        className="accent-slate-900 cursor-pointer"
                        title="Sync this MCP server to active coding agent"
                      />
                    </div>
                    <div className="text-[10px] font-mono text-slate-500 truncate">
                      {srv.transport} · {srv.url || srv.command || "configured"}
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {capTab === "memory" && (
            <>
              {profileMemories.length === 0 ? (
                <div className="p-3 text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg text-center space-y-1.5">
                  <div>No workspace memories saved yet.</div>
                  <button
                    type="button"
                    onClick={() => go("memory")}
                    className="text-blue-600 font-semibold hover:underline cursor-pointer"
                  >
                    Open Memory
                  </button>
                </div>
              ) : (
                profileMemories.slice(0, 20).map((mem) => (
                  <div key={mem.id} className="p-2 rounded-lg border border-slate-200/80 bg-white space-y-0.5">
                    <div className="text-[11px] font-semibold text-slate-900 truncate">{mem.title}</div>
                    <div className="text-[10px] text-slate-500 line-clamp-2">{mem.contentMarkdown}</div>
                  </div>
                ))
              )}
            </>
          )}
        </div>

        <div className="px-2.5 py-2 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between text-[10px] text-slate-500 shrink-0">
          <button type="button" onClick={() => go("skills")} className="hover:text-slate-900 font-medium cursor-pointer">
            Manage Skills
          </button>
          <button type="button" onClick={() => go("mesh")} className="hover:text-slate-900 font-medium cursor-pointer">
            MCP Mesh
          </button>
          <button type="button" onClick={() => go("memory")} className="hover:text-slate-900 font-medium cursor-pointer">
            Memory
          </button>
        </div>
      </aside>
    );
  }

  function renderPane(pane: PaneId) {
    if (pane === "explorer") return renderExplorerPane();
    if (pane === "capabilities") return renderCapabilitiesPane();
    return renderWorkspacePane();
  }

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-2.5 sm:p-4 overflow-hidden select-none flex flex-col font-sans">
      <div className="w-full max-w-[1800px] flex-1 min-h-0 bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden">
        {/* TOP HARNESS & LAYOUT HEADER */}
        <header className="h-14 bg-white border-b border-slate-100 px-3.5 flex items-center justify-between shrink-0 z-10 gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 scrollbar-none">
            <button
              type="button"
              onClick={() => go("chat")}
              className="px-2.5 py-1 text-xs font-semibold bg-white border border-slate-300 text-slate-900 hover:border-slate-900 rounded-lg flex items-center gap-1 transition cursor-pointer shadow-2xs shrink-0 mr-1"
              title="Back to Chat"
              aria-label="Back to Chat"
            >
              <ArrowLeft size={13} />
              <span>Back</span>
            </button>

            <div className="flex items-center gap-1.5 mr-1 shrink-0">
              <Sparkles size={15} className="text-blue-500" />
              <span className="font-bold text-[11px] uppercase tracking-wider text-slate-600">Harness:</span>
            </div>

            {HARNESSES.map((harness) => {
              const isSelected = activeAgent === harness.id;
              const pathVal = detectedPaths[harness.id] || "";
              const isDetected = pathVal.trim().length > 0;
              return (
                <button
                  key={harness.id}
                  type="button"
                  onClick={() => void handleSelectAgent(harness.id)}
                  title={
                    isDetected
                      ? `${harness.label} (${pathVal}) — auto-syncs Ronic OS skills, plugins & MCPs`
                      : `${harness.label} is not installed`
                  }
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shrink-0 cursor-pointer ${
                    isSelected
                      ? "bg-zinc-800 text-white border border-zinc-700/50 shadow-xs"
                      : "bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:border-slate-300"
                  }`}
                >
                  <span>{harness.label}</span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      isSelected
                        ? "bg-white/20 text-white"
                        : isDetected
                          ? "bg-slate-100 text-emerald-600 font-medium"
                          : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {isDetected ? (isSelected ? "Active" : "Ready") : "Not linked"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right Model Quick-Switch + Layout Controls + Open IDE */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="hidden lg:flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1" title="Switch model directly for active harness">
              <Cpu size={12} className="text-blue-600 shrink-0" />
              <select
                aria-label="Coding agent model"
                value={activeModelId}
                onChange={(e) => handleSelectModel(e.target.value)}
                className="bg-transparent text-[11px] font-mono font-semibold text-slate-800 outline-none max-w-[165px] cursor-pointer"
              >
                <option value="">Default Model</option>
                {availableModels.map((m) => (
                  <option key={`hdr:${m.source}:${m.id}`} value={m.id}>
                    {m.tier === "fast" ? `⚡ ${m.label}` : m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-0.5 bg-slate-100 p-0.5 rounded-lg border border-slate-200/70">
              <button
                type="button"
                onClick={() => setLayout((prev) => ({ ...prev, showLeft: !prev.showLeft }))}
                className={`p-1.5 rounded-md transition cursor-pointer ${
                  layout.showLeft ? "bg-white text-slate-900 shadow-2xs" : "text-slate-400 hover:text-slate-700"
                }`}
                title="Toggle Explorer (Projects, Sessions, Files)"
              >
                <PanelLeft size={13} />
              </button>
              <button
                type="button"
                onClick={() => setLayout((prev) => ({ ...prev, showTerminal: !prev.showTerminal }))}
                className={`p-1.5 rounded-md transition cursor-pointer ${
                  layout.showTerminal ? "bg-white text-slate-900 shadow-2xs" : "text-slate-400 hover:text-slate-700"
                }`}
                title="Toggle Terminal Drawer"
              >
                <PanelBottom size={13} />
              </button>
              <button
                type="button"
                onClick={() => setLayout((prev) => ({ ...prev, showRight: !prev.showRight }))}
                className={`p-1.5 rounded-md transition cursor-pointer ${
                  layout.showRight ? "bg-white text-slate-900 shadow-2xs" : "text-slate-400 hover:text-slate-700"
                }`}
                title="Toggle Ronic Capabilities Bridge (Skills, Plugins, MCPs)"
              >
                <PanelRight size={13} />
              </button>
              <button
                type="button"
                onClick={() => setLayout({ ...DEFAULT_LAYOUT })}
                className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-white transition cursor-pointer"
                title="Reset all draggable layouts to default"
              >
                <RotateCcw size={12} />
              </button>
            </div>

            <button
              type="button"
              onClick={handleOpenIde}
              title={`Open the installed ${ideLabel} window`}
              className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-300 hover:border-slate-900 text-slate-900 rounded-lg flex items-center gap-1.5 transition shadow-2xs hover:bg-slate-50 cursor-pointer"
            >
              <Columns size={13} className="text-slate-500" />
              <span className="hidden xl:inline">Open {ideLabel}</span>
            </button>
          </div>
        </header>

        {actionNotice && (
          <div className="bg-blue-50 border-b border-blue-200 px-4 py-1.5 text-xs font-medium text-blue-800 flex items-center justify-between shrink-0">
            <span className="truncate">{actionNotice}</span>
            <button type="button" onClick={() => setActionNotice(null)} className="text-blue-400 hover:text-blue-800 ml-2 cursor-pointer">
              <X size={13} />
            </button>
          </div>
        )}

        {/* MAIN RESIZABLE MULTI-COLUMN WORKSPACE + DRAGGABLE TERMINAL */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {visiblePanes.map((pane, idx) => {
              const nextPane = visiblePanes[idx + 1];
              return (
                <div key={pane} className={pane === "workspace" ? "flex-1 flex min-w-0 overflow-hidden" : "flex shrink-0 overflow-hidden"}>
                  {renderPane(pane)}
                  {nextPane && (
                    <div
                      onPointerDown={startResize("x", (delta) => {
                        const startLeft = layout.leftWidth;
                        const startRight = layout.rightWidth;
                        if (pane === "explorer" && nextPane === "capabilities") {
                          setLayout((prev) =>
                            clampLayout({ ...prev, leftWidth: startLeft + delta, rightWidth: startRight - delta }),
                          );
                        } else if (pane === "capabilities" && nextPane === "explorer") {
                          setLayout((prev) =>
                            clampLayout({ ...prev, rightWidth: startRight + delta, leftWidth: startLeft - delta }),
                          );
                        } else if (pane === "explorer") {
                          setLayout((prev) => clampLayout({ ...prev, leftWidth: startLeft + delta }));
                        } else if (nextPane === "explorer") {
                          setLayout((prev) => clampLayout({ ...prev, leftWidth: startLeft - delta }));
                        } else if (pane === "capabilities") {
                          setLayout((prev) => clampLayout({ ...prev, rightWidth: startRight + delta }));
                        } else if (nextPane === "capabilities") {
                          setLayout((prev) => clampLayout({ ...prev, rightWidth: startRight - delta }));
                        }
                      })}
                      onDoubleClick={() =>
                        setLayout((prev) => ({
                          ...prev,
                          leftWidth: DEFAULT_LAYOUT.leftWidth,
                          rightWidth: DEFAULT_LAYOUT.rightWidth,
                        }))
                      }
                      title="Drag to resize column (double-click to reset)"
                      className="w-1.5 bg-slate-100 hover:bg-blue-400/70 border-x border-slate-200 cursor-col-resize shrink-0 transition-colors"
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* DRAGGABLE HORIZONTAL SPLITTER FOR TERMINAL */}
          {layout.showTerminal && (
            <>
              <div
                onPointerDown={startResize("y", (delta) => {
                  const start = layout.terminalHeight;
                  setLayout((prev) => clampLayout({ ...prev, terminalHeight: start - delta }));
                })}
                onDoubleClick={() => setLayout((prev) => ({ ...prev, terminalHeight: DEFAULT_LAYOUT.terminalHeight }))}
                title="Drag to resize Terminal height (double-click to reset)"
                className="h-1.5 bg-slate-200 hover:bg-blue-400 cursor-row-resize shrink-0 transition-colors"
              />
              <div
                style={{ height: `${layout.terminalHeight}px` }}
                className="flex flex-col shrink-0 shadow-xs overflow-hidden"
              >
                <TerminalPanel
                  ref={terminalRef}
                  sessionId="coding_workspace"
                  cwd={projectRoot || undefined}
                  title="Interactive Shell"
                  onClose={() => setLayout((prev) => ({ ...prev, showTerminal: false }))}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CodingAgentsWorkspace;
