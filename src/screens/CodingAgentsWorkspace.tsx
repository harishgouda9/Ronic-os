import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Columns,
  Folder,
  GitBranch,
  Play,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { isTauri, pickPaths } from "../api";
import {
  dispatchOutput,
  clampFileIndex,
  filesAfterDispatch,
  filesFromPayload,
  ideToOpen,
  indexAfterRefresh,
  type ModifiedFile,
} from "../kernel/codingAgents";
import { launchDesktopApp } from "../lib/tauriBridge";
import { useRonic } from "../store";
import TerminalPanel from "../components/TerminalPanel";

interface AgentHarness {
  id: "claude" | "aider" | "opencode" | "codex" | "gemini" | "cursor" | "vscode";
  label: string;
  category: "cli" | "ide";
}

const HARNESSES: AgentHarness[] = [
  { id: "claude", label: "Claude Code CLI", category: "cli" },
  { id: "aider", label: "Aider", category: "cli" },
  { id: "opencode", label: "OpenCode CLI", category: "cli" },
  { id: "codex", label: "Codex CLI", category: "cli" },
  { id: "gemini", label: "Gemini CLI", category: "cli" },
  { id: "cursor", label: "Cursor", category: "ide" },
  { id: "vscode", label: "VS Code", category: "ide" },
];

function labelFor(id: string): string {
  return HARNESSES.find((item) => item.id === id)?.label ?? id;
}

export function CodingAgentsWorkspace() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const setToast = useRonic((s) => s.setToast);
  const go = useRonic((s) => s.go);

  const [activeAgent, setActiveAgent] = useState<AgentHarness["id"]>(
    (snap.ideAgent as AgentHarness["id"]) || "claude"
  );
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
  const [taskPrompt, setTaskPrompt] = useState<string>("");
  const [isDispatching, setIsDispatching] = useState<boolean>(false);
  const [isScanningGit, setIsScanningGit] = useState<boolean>(false);
  const [files, setFiles] = useState<ModifiedFile[]>([]);
  const [treeNote, setTreeNote] = useState<string>("Reading the git working tree…");
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<string>("");

  const projectRoot = snap.settings.projectRoot || "";

  const detectedPaths: Record<string, string> = {
    aider: snap.settings.aiderPath || "",
    opencode: snap.settings.opencodePath || "",
    claude: snap.settings.claudePath || "",
    codex: snap.settings.codexPath || "",
    gemini: snap.settings.geminiPath || "",
    cursor: (snap.apps || []).find((app) => app.id === "app_cursor")?.executablePath || "",
    vscode: (snap.apps || []).find((app) => app.id === "app_vscode")?.executablePath || "",
    uv: snap.settings.uvPath || "",
    bun: snap.settings.bunPath || "",
  };

  useEffect(() => {
    if (snap.ideAgent && snap.ideAgent !== activeAgent) {
      const match = HARNESSES.find((h) => h.id === snap.ideAgent);
      if (match) setActiveAgent(match.id);
    }
  }, [snap.ideAgent, activeAgent]);

  function showFiles(previous: ModifiedFile[], next: ModifiedFile[], note?: string) {
    setFiles(next);
    setSelectedFileIndex((current) => indexAfterRefresh(previous, next, current));
    if (note !== undefined) setTreeNote(note);
  }

  async function refreshTree() {
    setIsScanningGit(true);
    try {
      const res = await run("workspace_git", { action: "status", path: "", agent: "", prompt: "" });
      const next = filesFromPayload(res?.payload);
      if (next) {
        showFiles(files, next, next.length === 0 ? (res?.toast || "Working tree is clean.") : (res?.toast || ""));
      } else {
        setTreeNote(res?.toast || "Could not read git status.");
      }
    } finally {
      setIsScanningGit(false);
    }
  }

  useEffect(() => {
    void refreshTree();
  }, [projectRoot]);

  const activeFile = files[clampFileIndex(selectedFileIndex, files.length)];
  const agentPath = detectedPaths[activeAgent] || "";
  const agentReady = agentPath.trim().length > 0;

  async function handleSelectAgent(agentId: AgentHarness["id"]) {
    setActiveAgent(agentId);
    await run("set_ide_agent", { agent: agentId });
  }

  async function handleChangeProjectRoot() {
    try {
      const paths = await pickPaths("folder");
      if (paths && paths.length > 0 && paths[0]) {
        const nextRoot = paths[0];
        await run("save_settings", {
          settings: {
            ...snap.settings,
            projectRoot: nextRoot,
          },
        });
        setToast(`Project root changed to ${nextRoot}`);
      }
    } catch (err) {
      console.error("Failed to pick folder:", err);
    }
  }

  async function handleDispatch() {
    const prompt = taskPrompt.trim();
    if (!prompt) return;
    if (!agentReady) {
      setActionNotice(`${labelFor(activeAgent)} is not linked. Scan this computer, or set its path in Apps.`);
      return;
    }
    setIsDispatching(true);
    setActionNotice(null);
    try {
      const res = await run("workspace_git", {
        action: "dispatch",
        path: "",
        agent: activeAgent,
        prompt,
      });
      if (!res) {
        setActionNotice("The agent did not finish. The notice at the top of the window has the reason.");
        return;
      }
      const next = filesAfterDispatch(files, res.payload);
      showFiles(files, next);
      const output = dispatchOutput(res.payload);
      if (output) setRunLog(output);
      const exitCode = res.payload && typeof res.payload === "object" ? (res.payload as { exitCode?: number }).exitCode : undefined;
      setActionNotice(res.toast || "Dispatch did not run. Restart the desktop app if this command is new.");
      if (typeof exitCode === "number") setTaskPrompt("");
    } finally {
      setIsDispatching(false);
    }
  }

  async function handleAcceptHunk() {
    if (!activeFile) return;
    const res = await run("workspace_git", { action: "stage", path: activeFile.path, agent: "", prompt: "" });
    const next = filesFromPayload(res?.payload);
    if (next) showFiles(files, next);
    setActionNotice(res?.toast || `Staged ${activeFile.path}.`);
  }

  async function handleRejectHunk() {
    if (!activeFile) return;
    const res = await run("workspace_git", { action: "restore", path: activeFile.path, agent: "", prompt: "" });
    const next = filesFromPayload(res?.payload);
    if (next) showFiles(files, next);
    setActionNotice(res?.toast || `Restored ${activeFile.path}.`);
  }

  function handleAskRefine() {
    if (!activeFile) return;
    setTaskPrompt(`Refine the changes in ${activeFile.path}.`);
  }

  const idePartner = ideToOpen(activeAgent, {
    cursor: Boolean(detectedPaths.cursor),
    vscode: Boolean(detectedPaths.vscode),
  });
  const ideLabel = idePartner === "vscode" ? "VS Code" : "Cursor";
  const ideReady = Boolean(detectedPaths[idePartner]);
  const activeLabel = labelFor(activeAgent);

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

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-hidden select-none flex flex-col font-sans">
      <div className="w-full max-w-[1600px] flex-1 min-h-0 bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        <header className="h-14 bg-white border-b border-slate-100 px-4 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-2 overflow-x-auto py-1 scrollbar-none">
          <div className="flex items-center gap-1.5 mr-2 shrink-0">
            <button
              type="button"
              onClick={() => go("chat")}
              className="px-2.5 py-1 text-xs font-semibold bg-white border border-[#cbd5e1] text-[#0f172a] hover:border-[#0f172a] rounded-lg flex items-center gap-1 transition cursor-pointer shadow-2xs"
              title="Back to Chat"
              aria-label="Back to Chat"
            >
              <ArrowLeft size={13} />
              <span>Back</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5 mr-2 shrink-0">
            <Sparkles size={16} className="text-[#3b82f6]" />
            <span className="font-bold text-xs uppercase tracking-wider text-[#475569]">Harness:</span>
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
                title={isDetected ? `${harness.label} (${pathVal})` : `${harness.label} is not installed`}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition shrink-0 cursor-pointer ${
                  isSelected
                    ? "bg-zinc-800 text-white border border-zinc-700/50 shadow-xs"
                    : "bg-white border border-[#e2e8f0] text-[#475569] hover:text-[#0f172a] hover:border-[#cbd5e1]"
                }`}
              >
                <span>{harness.label}</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    isSelected
                      ? "bg-white/20 text-white"
                      : isDetected
                        ? "bg-[#f1f5f9] text-[#059669] font-medium"
                        : "bg-[#f1f5f9] text-[#94a3b8]"
                  }`}
                >
                  {isDetected ? (isSelected ? "Active" : "Ready") : "Not linked"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          <button
            type="button"
            onClick={handleOpenIde}
            title={`Open the installed ${ideLabel} window`}
            className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#cbd5e1] hover:border-[#0f172a] text-[#0f172a] rounded-lg flex items-center gap-1.5 transition shadow-2xs hover:bg-[#f8fafc] cursor-pointer"
          >
            <Columns size={13} className="text-[#64748b]" />
            <span>Open {ideLabel}</span>
          </button>
        </div>
      </header>

      {actionNotice && (
        <div className="bg-[#eff6ff] border-b border-[#bfdbfe] px-4 py-1.5 text-xs font-medium text-[#1e40af] flex items-center justify-between">
          <span>{actionNotice}</span>
          <button type="button" onClick={() => setActionNotice(null)} className="text-[#60a5fa] hover:text-[#1e40af]">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[340px] bg-white border-r border-[#e2e8f0] p-3.5 flex flex-col justify-between shrink-0 overflow-y-auto shadow-xs">
          <div className="space-y-4">
            <div className="bg-[#f8fafc] border border-[#e2e8f0] rounded-xl p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-[#64748b] flex items-center gap-1">
                  <Folder size={11} /> Project Root
                </span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void run("scan_environment")}
                    className="text-[11px] font-medium text-[#2563eb] hover:text-[#1d4ed8] hover:underline cursor-pointer"
                  >
                    Scan
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleChangeProjectRoot()}
                    className="text-[11px] font-medium text-[#2563eb] hover:text-[#1d4ed8] hover:underline cursor-pointer"
                  >
                    Change Folder
                  </button>
                </span>
              </div>
              <div
                className="text-xs font-mono font-semibold truncate text-[#0f172a] bg-white border border-[#e2e8f0] px-2 py-1 rounded-md"
                title={projectRoot || "No project folder yet"}
              >
                {projectRoot || "No project folder yet"}
              </div>
              <div className="flex items-center justify-between text-[10px] text-[#64748b] pt-1">
                <span>uv: {detectedPaths.uv ? "Ready" : "Not linked"}</span>
                <span>bun: {detectedPaths.bun ? "Ready" : "Not linked"}</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-bold text-[#334155] px-1">
                <span className="flex items-center gap-1.5">
                  <GitBranch size={13} className="text-[#059669]" />
                  <span>Changed Files ({files.length})</span>
                </span>
                <button
                  type="button"
                  onClick={() => void refreshTree()}
                  disabled={isScanningGit}
                  className="text-[11px] font-medium text-[#2563eb] hover:text-[#1d4ed8] flex items-center gap-1 cursor-pointer"
                  title="Read git status in the project folder"
                >
                  <RefreshCw size={11} className={isScanningGit ? "spin" : ""} />
                  <span>Refresh</span>
                </button>
              </div>

              {files.length === 0 ? (
                <div className="p-3 text-[11px] text-[#64748b] border border-dashed border-[#e2e8f0] rounded-lg">
                  {treeNote || "No uncommitted changes."}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {files.map((file, idx) => {
                    const isSelected = idx === selectedFileIndex;
                    const filename = file.path.split(/[/\\]/).pop() || file.path;
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setSelectedFileIndex(idx)}
                        className={`w-full text-left p-2.5 rounded-lg border text-xs transition flex items-center justify-between gap-2 cursor-pointer ${
                          isSelected
                            ? "border-[#0f172a] bg-[#f8fafc] shadow-xs"
                            : "border-[#e2e8f0] bg-white hover:bg-[#f8fafc]"
                        }`}
                      >
                        <div className="truncate min-w-0">
                          <div className="font-mono font-semibold text-[#0f172a] truncate">{filename}</div>
                          <div className="text-[10px] text-[#64748b] truncate">{file.path}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[10px] font-mono font-bold text-[#059669]">+{file.additions}</span>
                          <span className="text-[10px] font-mono font-bold text-[#e11d48]">-{file.deletions}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2 pt-3 border-t border-[#e2e8f0]">
              <div className="flex items-center justify-between">
                <label htmlFor="agent-task-input" className="text-xs font-bold text-[#0f172a]">
                  Assign task to {activeLabel}
                </label>
                <span className={`text-[10px] font-mono font-medium ${agentReady ? "text-[#059669]" : "text-[#94a3b8]"}`}>
                  {agentReady ? "Program found" : "Not linked"}
                </span>
              </div>

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
                placeholder={agentReady ? "What should this agent change in the project?" : "Link this agent before dispatching a task."}
                className="w-full p-2.5 text-xs font-sans border border-[#cbd5e1] rounded-lg outline-none focus:border-[#0f172a] focus:ring-1 focus:ring-[#0f172a] bg-[#f8fafc] text-[#0f172a] placeholder-[#94a3b8] resize-none"
              />

              <button
                type="button"
                onClick={() => void handleDispatch()}
                disabled={isDispatching || !taskPrompt.trim() || !agentReady}
                className={`w-full py-2.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  isDispatching || !taskPrompt.trim() || !agentReady
                    ? "bg-[#94a3b8] text-white cursor-not-allowed"
                    : "bg-[#0f172a] text-white hover:bg-[#1e293b] shadow-xs"
                }`}
              >
                <Play size={12} className={isDispatching ? "spin" : "fill-current"} />
                <span>{isDispatching ? "Agent running…" : `Run ${activeLabel}`}</span>
              </button>
              <div className="text-[10px] font-mono text-[#64748b] truncate" title={agentPath || "No program path yet"}>
                {agentPath || "No program path yet"}
              </div>
            </div>
          </div>

          <div className="text-[10px] font-mono text-[#64748b] border-t border-[#e2e8f0] pt-2.5 mt-3">
            CLI agents run in this folder. Cursor and VS Code open it, and the task stays in the run log. Ctrl+Enter runs the task.
          </div>
        </aside>

        <main className="flex-1 flex flex-col justify-between overflow-hidden bg-[#f8fafc]">
          <div className="flex-1 p-4 overflow-y-auto space-y-3">
            {runLog && (
              <div className="bg-white border border-[#e2e8f0] rounded-xl overflow-hidden shadow-xs">
                <div className="bg-[#f8fafc] border-b border-[#e2e8f0] px-4 py-2 text-[11px] font-bold text-[#475569] flex items-center justify-between">
                  <span>Last run</span>
                  <button type="button" onClick={() => setRunLog("")} className="text-[#94a3b8] hover:text-[#0f172a] cursor-pointer">
                    Clear
                  </button>
                </div>
                <pre className="p-3 whitespace-pre-wrap leading-relaxed text-xs font-mono text-[#0f172a] max-h-48 overflow-auto">{runLog}</pre>
              </div>
            )}
            {activeFile ? (
              <>
                <div className="flex items-center justify-between bg-white border border-[#e2e8f0] p-3 rounded-xl shadow-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs font-bold text-[#0f172a] truncate">{activeFile.path}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-[#f1f5f9] text-[#475569] rounded-md font-medium">
                      +{activeFile.additions} -{activeFile.deletions}
                    </span>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md font-semibold ${activeFile.staged ? "bg-[#ecfdf5] text-[#059669]" : "bg-[#fef2f2] text-[#e11d48]"}`}>
                      {activeFile.staged ? "Staged" : "Working tree"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button type="button" onClick={() => void handleAcceptHunk()} className="px-3 py-1.5 text-xs font-semibold bg-[#059669] hover:bg-[#047857] text-white rounded-lg flex items-center gap-1 shadow-2xs transition cursor-pointer">
                      <Check size={13} />
                      <span>Stage</span>
                    </button>
                    <button type="button" onClick={() => void handleRejectHunk()} className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#e2e8f0] hover:border-[#e11d48] text-[#e11d48] rounded-lg flex items-center gap-1 transition cursor-pointer">
                      <X size={13} />
                      <span>Restore</span>
                    </button>
                    <button type="button" onClick={handleAskRefine} className="px-3 py-1.5 text-xs font-semibold bg-[#f1f5f9] hover:bg-[#e2e8f0] text-[#334155] rounded-lg transition cursor-pointer">
                      Ask agent to refine
                    </button>
                  </div>
                </div>
                <div className="bg-white border border-[#e2e8f0] rounded-xl overflow-hidden font-mono text-xs shadow-xs">
                  <div className="bg-[#f8fafc] border-b border-[#e2e8f0] px-4 py-2 text-[11px] font-bold text-[#475569]">
                    git diff
                  </div>
                  <pre className="p-3 whitespace-pre-wrap leading-relaxed overflow-x-auto">
                    {activeFile.diff.split("\n").map((line, idx) => {
                      const color = line.startsWith("+") && !line.startsWith("+++")
                        ? "text-[#166534] bg-[#f0fdf4]"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "text-[#9f1239] bg-[#fff1f2]"
                          : "text-[#334155]";
                      return (
                        <div key={idx} className={color}>
                          {line || " "}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              </>
            ) : (
              <div className="p-6 text-sm text-[#64748b] bg-white border border-[#e2e8f0] rounded-xl">
                {treeNote || "No diff to show. Refresh after you change a file."}
              </div>
            )}
          </div>
          <div className="h-64 border-t border-[#e2e8f0] flex flex-col shrink-0 shadow-xs overflow-hidden">
            <TerminalPanel sessionId="coding_workspace" title="Interactive Shell (PowerShell / Bash)" />
          </div>
        </main>
      </div>
      </div>
    </div>
  );
}

export default CodingAgentsWorkspace;
