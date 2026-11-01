import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { AlertCircle, Brain, Check, ChevronDown, ChevronLeft, ChevronUp, Copy, Download, Eye, EyeOff, FileText, Folder, Globe, Image, Minimize2, Minus, Plus, RefreshCw, Reply, Sparkles, Square, Terminal as TerminalIcon, X } from "lucide-react";

import ReactMarkdown from "react-markdown";

import remarkGfm from "remark-gfm";

import { isTauri, pickPaths, saveExportedFile } from "../api";

import { clipName, customAsWebApp, newCustomId, readCustomApps, readHiddenApps, validWebUrl, writeCustomApps, writeHiddenApps, type CustomApp } from "../kernel/customApps";

import { chatProviderLinks, DOWNLOADS, hasStoredSecret, WEB_APPS, type ChatModel, type WebApp } from "../kernel/liveChat";

import { addCustom, catalog, effortFor, hideModel, loadConnectedModels, saveEdit, setEffort, starIds, toggleStar } from "../kernel/modelPrefs";

import { inIndex, proposedDiff } from "../kernel/skillIndex";

import { bridgeStatus, hideWorkspaceWebapps, listInstalledWebapps, openHarnessWindow, placeWorkspaceWebapp, showWorkspaceWebapp, type WebAppBounds } from "../lib/tauriBridge";

import type { BotProfile, Provider, Step } from "../types";

import { useRonic } from "../store";

import { hunksOf, Pill, tone } from "../ui/bits";

import { DockAccounts } from "../ui/DockAccounts";

import { DockCapabilities } from "../ui/DockCapabilities";

import { AppLogo } from "../ui/appLogos";

import { ModelMenu } from "../ui/ModelMenu";

import { BotFace, botName, botPresence, ComputerDock, CoworkerSidebar, GatewayCard, HandoffLine, MODES, modeLabel, ProfileSlide } from "../ui/BotCoworkers";

import { Harness2PipelineCard, SuperchargeControl } from "../components/Harness2Studio";

import { markFired, markSeen, oneLine, readTabs, rememberModel, safePageUrl, writeTabs } from "../kernel/workspaceChrome";

import { LiveBrowser } from "../ui/LiveBrowser";

import { MicButton } from "../ui/MicButton";

import { ScheduledJobs } from "../ui/ScheduledJobs";

import { PaneButton, PaneEdge, usePane } from "../ui/PaneEdge";



const DOCK_KEY = "ronic.dock";

const MODEL_KEY = "ronic.selectedModel.v1";

type DockTab = "apps" | "accounts" | "capabilities";

type AppsSide = "web" | "desktop";

type DockState = { open: boolean; width: number; tab: DockTab; apps: AppsSide };

const WEBAPP_KEY = "ronic.webapps";

const DESK_ROWS: Record<string, string> = {

  ollama: "app_ollama",

  "claude-code": "app_claude",

  cursor: "app_cursor",

  vscode: "app_vscode",

  obsidian: "app_obsidian",

};



function clampDock(width: number) {

  if (!Number.isFinite(width)) return 280;

  return Math.min(480, Math.max(220, Math.round(width)));

}



function turnGroups(steps: Step[]) {

  const turns: { id: string; steps: Step[] }[] = [];

  for (const step of steps) {

    const id = step.turnId ? step.turnId : `s:${step.id}`;

    const last = turns[turns.length - 1];

    if (last && last.id === id) last.steps.push(step);

    else turns.push({ id, steps: [step] });

  }

  return turns;

}



type TurnChunk =

  | { kind: "step"; step: Step }

  | { kind: "process"; steps: Step[]; id: string };



export function cleanUserMessage(content: string): string {

  if (!content) return "";

  return content

    .replace(/\[APPROVAL MODE:[\s\S]*?\]/gi, "")

    .replace(/\[FORMATTING DIRECTIVE:[\s\S]*?\]/gi, "")

    .trim();

}



function chunkTurnSteps(steps: Step[]): TurnChunk[] {

  const chunks: TurnChunk[] = [];

  let currentProcess: Step[] = [];



  const flushProcess = () => {

    if (currentProcess.length > 0) {

      chunks.push({

        kind: "process",

        steps: [...currentProcess],

        id: `process_${currentProcess[0].id}`,

      });

      currentProcess = [];

    }

  };



  for (const step of steps) {

    const isProcess =

      step.actionType === "harness2_pipeline" ||

      step.actionType === "thinking" ||

      step.role === "tool" ||

      step.actionType === "handoff_capsule" ||

      step.actionType === "bot_handoff";

    if (isProcess) {

      currentProcess.push(step);

    } else {

      flushProcess();

      chunks.push({ kind: "step", step });

    }

  }

  flushProcess();



  return chunks;

}



function dockTab(value: unknown): DockTab {

  return value === "accounts" || value === "capabilities" || value === "apps" ? value : "apps";

}



function appsSide(value: unknown): AppsSide {

  return value === "desktop" ? "desktop" : "web";

}



function readDock(): DockState {

  try {

    const raw = localStorage.getItem(DOCK_KEY);

    if (!raw) return { open: true, width: 280, tab: "apps", apps: "web" };

    const parsed = JSON.parse(raw) as { open?: boolean; width?: number; tab?: unknown; apps?: unknown };

    return { open: parsed.open !== false, width: clampDock(parsed.width ?? 280), tab: dockTab(parsed.tab), apps: appsSide(parsed.apps) };

  } catch {

    return { open: true, width: 280, tab: "apps", apps: "web" };

  }

}



function writeDock(dock: DockState) {

  localStorage.setItem(DOCK_KEY, JSON.stringify(dock));

}



function readWebapps() {

  try {

    const raw = localStorage.getItem(WEBAPP_KEY);

    const parsed = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];

  } catch {

    return [];

  }

}



function readSelected() {

  try {

    return localStorage.getItem(MODEL_KEY) ?? "";

  } catch {

    return "";

  }

}



function errorText(error: unknown) {

  if (typeof error === "string") return error;

  if (error instanceof Error) return error.message;

  return String(error);

}



export function ApprovalModeControl() {

  const mode = useRonic((s) => s.approvalMode);

  const setMode = useRonic((s) => s.setApprovalMode);

  const snap = useRonic((s) => s.snap);

  const run = useRonic((s) => s.run);



  const handleSelect = async (nextMode: "auto" | "ask" | "manual") => {

    setMode(nextMode);

    const profile = snap?.profiles.find((p) => p.id === snap.activeProfileId);

    if (profile && profile.approvalMode !== nextMode) {

      await run("save_profile", {

        profile: {

          ...profile,

          approvalMode: nextMode,

          requireApprovalExternal: nextMode !== "auto",

          requireApprovalWallet: nextMode !== "auto",

        },

      });

    }

  };



  return (

    <div className="approval-mode-control" role="group" aria-label="Bot Approval Mode">

      <button

        type="button"

        className={`approval-mode-btn ${mode === "auto" ? "active auto" : ""}`}

        onClick={() => void handleSelect("auto")}

        title="Auto Approve: Bot researches, plans, decides autonomously, and builds without asking questions (only asks for critical actions or credentials)."

      >

        <Sparkles size={11} />

        <span>Auto</span>

      </button>

      <button

        type="button"

        className={`approval-mode-btn ${mode === "ask" ? "active ask" : ""}`}

        onClick={() => void handleSelect("ask")}

        title="Ask: Bot asks clarifying questions and checks with user before executing major tasks."

      >

        <span>Ask</span>

      </button>

      <button

        type="button"

        className={`approval-mode-btn ${mode === "manual" ? "active manual" : ""}`}

        onClick={() => void handleSelect("manual")}

        title="Manual: Bot confirms each step manually before execution."

      >

        <span>Manual</span>

      </button>

    </div>

  );

}



export function Chat() {

  const snap = useRonic((s) => s.snap)!;

  const run = useRonic((s) => s.run);

  const go = useRonic((s) => s.go);

  const busy = useRonic((s) => s.busy);

  const pending = useRonic((s) => s.pending);

  const generation = useRonic((s) => s.generation);

  const recover = useRonic((s) => s.recover);

  const recovering = useRonic((s) => s.recovering);

  const terminal = useRonic((s) => s.terminal);

  const setTerminal = useRonic((s) => s.setTerminal);

  const [prompt, setPrompt] = useState("");

  const [files, setFiles] = useState<string[]>([]);

  const [modelId, setModelId] = useState(readSelected);

  const [modelsReady, setModelsReady] = useState(false);

  const [models, setModels] = useState<ChatModel[]>([]);

  const [ollamaReady, setOllamaReady] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);

  const [focusGroup, setFocusGroup] = useState("");

  const [focusTick, setFocusTick] = useState(0);

  const [menuMode, setMenuMode] = useState<"list" | "add" | "edit">("list");

  const [stars, setStars] = useState<string[]>(() => starIds());

  const [menuStatus, setMenuStatus] = useState("");

  const [refreshing, setRefreshing] = useState(false);

  const [effortTick, setEffortTick] = useState(0);

  const [skillsOpen, setSkillsOpen] = useState(false);

  const [pluginsOpen, setPluginsOpen] = useState(false);

  const [inspectedId, setInspectedId] = useState("");

  const [screenMode, setScreenMode] = useState<"closed" | "preview" | "takeover">("closed");

  const [screenDockTab, setScreenDockTab] = useState<"computer" | "browser">("computer");

  const [plusOpen, setPlusOpen] = useState(false);

  const [chatsOpen, setChatsOpen] = useState(false);

  const [profileBotId, setProfileBotId] = useState("");

  const [dock, setDock] = useState(readDock);

  const [dockFooterOpen, setDockFooterOpen] = useState(false);

  const [openApp, setOpenApp] = useState<WebApp | null>(null);

  const [stageMode, setStageMode] = useState<"split" | "full" | "min">("split");

  const [deskSide, setDeskSide] = useState<{ name: string; detail: string } | null>(null);

  const rosterPane = usePane("ronic.pane.roster", 280);

  const pagePane = usePane("ronic.pane.page", 420);

  const previewPane = usePane("ronic.pane.preview", 340);

  const threadPane = usePane("ronic.pane.thread", 640);

  const stagePane = usePane("ronic.pane.stage", 560);

  const [installed, setInstalled] = useState<string[]>(readWebapps);

  const [focusNonce, setFocusNonce] = useState(0);

  const [deskBusy, setDeskBusy] = useState<string | null>(null);

  const [deskMode, setDeskMode] = useState<"open" | "install">("open");

  const [installAsk, setInstallAsk] = useState<string | null>(null);

  const [deskNote, setDeskNote] = useState("");

  const [bridgeNote, setBridgeNote] = useState("");

  const [customApps, setCustomApps] = useState<CustomApp[]>(readCustomApps);

  const [hiddenApps, setHiddenApps] = useState<string[]>(readHiddenApps);

  const [addKind, setAddKind] = useState<"web" | "desktop" | null>(null);

  const [addName, setAddName] = useState("");

  const [addUrl, setAddUrl] = useState("");

  const [addPath, setAddPath] = useState("");

  const [addError, setAddError] = useState("");

  const [optimisticSteps, setOptimisticSteps] = useState<Step[]>([]);

  const [chatError, setChatError] = useState<string | null>(null);

  const [lastSentPrompt, setLastSentPrompt] = useState<string>("");

  const [lastSentFiles, setLastSentFiles] = useState<string[]>([]);

  const [openTabs, setOpenTabs] = useState<string[]>(readTabs);

  const [browserOpen, setBrowserOpen] = useState(false);

  const [jobsOpen, setJobsOpen] = useState(false);

  const [jobsNudge, setJobsNudge] = useState(0);



  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);

  const threadBox = useRef<HTMLElement | null>(null);

  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const isScrolledUpRef = useRef(false);







  useEffect(() => {

    if (!isTauri()) return;

    let unlistenOpen: (() => void) | undefined;

    let unlistenClose: (() => void) | undefined;

    import("@tauri-apps/api/event").then(({ listen }) => {

      listen<{ id: string; name?: string; url?: string }>("ronic://open-workspace-webapp", (event) => {

        const { id, name, url } = event.payload;

        const customMatch = customApps.find((c) => c.id === id);

        const found: WebApp | null =

          WEB_APPS.find((w) => w.id === id) ||

          (customMatch ? customAsWebApp(customMatch) : null) ||

          (url

            ? {

                id,

                name: name || id,

                url,

                mark: "AP",

                providerId: "",

                custom: true,

              }

            : null);

        if (found) {

          setDeskSide(null);

          revealStage();

          setFocusNonce((t) => t + 1);

          setOpenApp(found);

        }

      }).then((u) => {

        unlistenOpen = u;

      });



      listen("ronic://close-workspace-webapp", () => {

        setOpenApp(null);

        setStageMode("split");

      }).then((u) => {

        unlistenClose = u;

      });

    });

    return () => {

      unlistenOpen?.();

      unlistenClose?.();

    };

  }, [customApps]);



  useEffect(() => {

    if (stageMode === "min" && stagePane.open) setStageMode("split");

  }, [stageMode, stagePane.open]);



  useEffect(() => {

    const el = threadBox.current;

    if (!el) return;

    const watch = () => {

      if (document.body.dataset.paneDrag !== "1") return;

      if (el.getBoundingClientRect().width < 88) threadPane.collapse();

    };

    const obs = new ResizeObserver(watch);

    obs.observe(el);

    return () => obs.disconnect();

  }, [threadPane.open, stageMode]);



  function handleTranscriptScroll() {

    const el = transcriptRef.current;

    if (!el) return;

    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;

    const isUp = distance > 60;

    isScrolledUpRef.current = isUp;

    setShowScrollBottom(isUp);

  }



  function scrollToBottom(smooth = true) {

    const el = transcriptRef.current;

    if (!el) return;

    el.scrollTo({

      top: el.scrollHeight,

      behavior: smooth ? "smooth" : "auto",

    });

    isScrolledUpRef.current = false;

    setShowScrollBottom(false);

  }

  const sending = useRef(false);

  const seenGen = useRef(generation);

  if (seenGen.current !== generation) {

    seenGen.current = generation;

    sending.current = false;

  }

  const dockWidth = useRef(dock.width);

  const dockState = useRef(dock);

  dockState.current = dock;

  const profile = snap.profiles.find((item) => item.id === snap.activeProfileId) ?? snap.profiles[0];

  const thread = snap.threads.find((item) => item.id === snap.activeThreadId);

  const activeGroup = thread?.targetType === "bot_group" ? snap.botGroups.find((item) => item.id === thread.groupId) : undefined;

  const inspected = snap.profiles.find((item) => item.id === inspectedId) ?? profile;

  const accessBot = inspected && (!activeGroup || activeGroup.memberBotIds.includes(inspected.id)) ? inspected : profile;

  const tasks = snap.threads.filter((item) => activeGroup ? item.groupId === activeGroup.id : item.targetType !== "bot_group" && item.botProfileId === (profile?.id ?? ""));

  const talkTo = activeGroup ? activeGroup.title.replace(/^#/, "") || activeGroup.groupHandle : botName(accessBot);

  const steps = useMemo(() => snap.steps.filter((item) => item.threadId === snap.activeThreadId && item.actionType !== "turn_activity"), [snap.steps, snap.activeThreadId]);

  const allSteps = useMemo(() => {

    if (optimisticSteps.length === 0) return steps;

    const unconfirmed = optimisticSteps.filter((opt) =>

      !steps.some((s) => {

        if (s.role !== "user" || Math.abs(s.createdAt - opt.createdAt) >= 120000) return false;

        const got = s.contentMarkdown.trim();

        const want = opt.contentMarkdown.trim();

        return got === want || got.startsWith(want);

      })

    );

    if (unconfirmed.length === 0) return steps;

    return [...steps, ...unconfirmed];

  }, [steps, optimisticSteps]);

  const groupedTurns = useMemo(() => turnGroups(allSteps), [allSteps]);



  const isWorking = Boolean(

    sending.current ||

    pending === "send_message" ||

    pending === "run_routine" ||

    pending === "resolve_gateway" ||

    deskBusy !== null ||

    busy ||

    Boolean(snap.turnActivity && snap.turnActivity.trim().length > 0)

  );



  const messageQueue = useRonic((s) => s.messageQueue);

  const queueMessage = useRonic((s) => s.queueMessage);

  const dequeueMessage = useRonic((s) => s.dequeueMessage);



    // Auto-resize textarea to keep write bar compact and prevent disruption
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const h = Math.min(120, Math.max(28, textareaRef.current.scrollHeight));
      textareaRef.current.style.height = `${h}px`;
    }
  }, [prompt]);

  // Handle reply to bot response
  const handleReply = useCallback((content: string, modelUsed?: string) => {
    const label = botHeaderLabel(modelUsed);
    const clean = content.trim().replace(/^>.*$/gm, "").trim();
    const firstLines = clean.split("\n").filter(Boolean).slice(0, 2).join(" ");
    const snippet = firstLines.slice(0, 140);
    const quote = `> @${label}: "${snippet}${snippet.length >= 140 ? "..." : ""}"\n\n`;

    setPrompt((prev) => (prev.trim() ? `${quote}${prev}` : quote));

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
      }
    }, 40);
  }, []);

  const displayActivity = useMemo(() => {

    if (deskBusy !== null) {

      return deskMode === "install" ? "installing app..." : "opening app...";

    }

    if (pending === "run_routine") return "running routine...";

    if (pending === "resolve_gateway") return "verifying security gateway...";

    if (snap.turnActivity && snap.turnActivity.trim()) return snap.turnActivity.trim();

    if (pending === "send_message" || busy) return "bot is working in background...";

    return "working in background...";

  }, [deskBusy, deskMode, pending, snap.turnActivity, busy]);



  // Live per-tool activity from the kernel (very small letters under the pill).

  const liveDetail = useMemo(() => {

    const fromKernel = (snap.turnActivity ?? "").trim();

    if (fromKernel) return fromKernel;

    for (let i = snap.steps.length - 1; i >= 0; i -= 1) {

      const step = snap.steps[i];

      if (step.threadId === snap.activeThreadId && step.actionType === "turn_activity") {

        return step.contentMarkdown.trim();

      }

    }

    return "";

  }, [snap.turnActivity, snap.steps, snap.activeThreadId]);



  const keyedIds = snap.providers.filter((item) => item.hasSecret || hasStoredSecret(item.id)).map((item) => item.id);

  const keyedKey = keyedIds.join("|");

  const model = models.find((item) => item.id === modelId) ?? null;

  const selectedProvider = model ? snap.providers.find((item) => item.id === model.providerId) : undefined;

  const addedWeb = customApps.filter((item) => item.kind === "web").map(customAsWebApp);

  const addedDesk = customApps.filter((item) => item.kind === "desktop").map(customAsWebApp);

  const links = chatProviderLinks((id) => id === "prov_ollama" ? ollamaReady : keyedIds.includes(id));

  const menuProviders = links.filter((link) => link.id && !link.siteOnly).map((link) => ({ id: link.id, name: link.name }));

  const profileBot = snap.profiles.find((item) => item.id === profileBotId);

  const effort = model ? effortFor(model.id) : "default";

  const sessionHint = !modelsReady

    ? "Checking this computer for connected models."

    : keyedIds.length === 0

      ? "No API key is stored. Open Accounts and paste a key, or start Ollama."

      : models.length === 0

        ? (menuStatus || "A key is stored. Refresh the model list, or add a model id in Accounts.")

        : `${models.length} models are ready. Open Select a model.`;

  void effortTick;



  useEffect(() => {

    setOptimisticSteps([]);

    setChatError(null);

    scrollToBottom(false);

  }, [snap.activeThreadId]);



  useEffect(() => {

    const id = snap.activeThreadId;

    if (!id) return;

    setOpenTabs((prev) => {

      if (prev.includes(id)) return prev;

      const next = [...prev, id].slice(-12);

      writeTabs(next);

      return next;

    });

  }, [snap.activeThreadId]);



  useEffect(() => {

    if (thread) markSeen(thread.id, thread.updatedAt);

  }, [thread?.id, thread?.updatedAt]);



  useEffect(() => {

    if (!model) return;

    rememberModel({ id: model.id, providerId: model.providerId, upstreamModel: model.upstreamModel });

  }, [model?.id, model?.providerId, model?.upstreamModel]);



  async function handleRefreshChat() {

    sending.current = false;

    setOptimisticSteps([]);

    setChatError(null);

    setDeskBusy(null);

    setRefreshing(true);

    try {

      await recover();

      const ids = keyedKey.length ? keyedKey.split("|") : [];

      const result = await loadConnectedModels(ids);

      const next = catalog(ids, result.ollama);

      setOllamaReady(result.ollama);

      setModels(next);

      setModelsReady(true);

      setMenuStatus(result.notes.join(" "));

      setModelId((current) => next.some((item) => item.id === current) ? current : (next[0]?.id ?? ""));

      requestAnimationFrame(() => {

        scrollToBottom(false);

      });

    } catch (err) {

      console.error("Refresh failed:", err);

    } finally {

      setRefreshing(false);

    }

  }



  // The [keyedKey] effect below loads the model list on mount with the full

  // selection precedence (focus harness, saved, thread, profile). Skip this

  // effect's first run so the two don't race two invoke() calls and two

  // conflicting setModelId updaters; it only needs to react to mid-session

  // recoveries, which bump the store generation.

  const skippedFirstGenerationRun = useRef(false);

  useEffect(() => {

    if (generation === 0) return;

    if (!skippedFirstGenerationRun.current) {

      skippedFirstGenerationRun.current = true;

      return;

    }

    sending.current = false;

    setOptimisticSteps([]);

    setChatError(null);

    setDeskBusy(null);

    const ids = keyedKey.length ? keyedKey.split("|") : [];

    void loadConnectedModels(ids).then((result) => {

      const next = catalog(ids, result.ollama);

      setOllamaReady(result.ollama);

      setModels(next);

      setModelsReady(true);

      setMenuStatus(result.notes.join(" "));

      setModelId((current) => next.some((item) => item.id === current) ? current : (next[0]?.id ?? ""));

      requestAnimationFrame(() => {

        scrollToBottom(false);

      });

    }).catch((error) => {

      setModelsReady(true);

      setMenuStatus(errorText(error));

    });

  }, [generation]);



  useEffect(() => {

    if (!isScrolledUpRef.current) {

      scrollToBottom(true);

    }

  }, [allSteps.length, isWorking, chatError]);



  useEffect(() => {

    try {

      if (modelId) localStorage.setItem(MODEL_KEY, modelId);

      else localStorage.removeItem(MODEL_KEY);

    } catch {

      /* selection still works for this visit */

    }

  }, [modelId]);



  useEffect(() => {

    const prefill = sessionStorage.getItem("ronic.prefillPrompt");

    if (prefill) {

      sessionStorage.removeItem("ronic.prefillPrompt");

      setPrompt(prefill);

    }

    const focus = sessionStorage.getItem("ronic.focusHarness");

    if (focus) sessionStorage.removeItem("ronic.focusHarness");

    const ids = keyedKey.length ? keyedKey.split("|") : [];

    let gone = false;

    loadConnectedModels(ids).then((result) => {

      if (gone) return;

      const next = catalog(ids, result.ollama);

      setOllamaReady(result.ollama);

      setModels(next);

      setModelsReady(true);

      setMenuStatus(result.notes.join(" "));

      setModelId((current) => {

        if (focus) {

          const match = next.find((item) => item.providerId === focus);

          if (match) return match.id;

        }

        if (current && next.some((item) => item.id === current)) return current;

        const saved = readSelected();

        if (saved && next.some((item) => item.id === saved)) return saved;

        if (thread?.activeModelOverrideId) {

          const match = next.find((item) => item.providerId === thread.activeModelOverrideId);

          if (match) return match.id;

        }

        if (profile?.primaryAccountId) {

          const match = next.find((item) => item.providerId === profile.primaryAccountId);

          if (match) return match.id;

        }

        return next[0]?.id ?? "";

      });

    }).catch((error) => {

      if (!gone) {

        setModelsReady(true);

        setMenuStatus(errorText(error));

      }

    });

    return () => {

      gone = true;

    };

  }, [keyedKey]);



  useEffect(() => {

    if (!isTauri()) return;

    void listInstalledWebapps().then(setInstalled).catch(() => {});

    void bridgeStatus().then((status) => {

      if (!status.port) return;

      const names = status.clients.map((item) => item.split(" (")[0]).join(", ");

      setBridgeNote(names ? `Skills bridge on ${status.endpoint} for ${names}.` : `Skills bridge on ${status.endpoint}.`);

    }).catch(() => {});

  }, []);



  function rememberInstalled(id: string) {

    setInstalled((prev) => {

      if (prev.includes(id)) return prev;

      const next = [...prev, id];

      localStorage.setItem(WEBAPP_KEY, JSON.stringify(next));

      return next;

    });

  }



  function setDockOpen(open: boolean) {

    setDock((prev) => {

      const next = { ...prev, open };

      writeDock(next);

      return next;

    });

  }



  function toggleAdd(kind: "web" | "desktop") {

    setAddError("");

    setAddName("");

    setAddUrl("");

    setAddPath("");

    setAddKind((current) => current === kind ? null : kind);

  }



  function saveAdded() {

    const name = clipName(addName);

    if (!name) {

      setAddError("Enter a name.");

      return;

    }

    if (customApps.length >= 24) {

      setAddError("The dock holds 24 added apps. Remove one to add another.");

      return;

    }

    if (addKind === "web") {

      const url = validWebUrl(addUrl);

      if (!url) {

        setAddError("Use an https address. http works only for localhost.");

        return;

      }

      const next = [...customApps, { id: newCustomId("web"), name, kind: "web" as const, url, path: "" }];

      writeCustomApps(next);

      setCustomApps(next);

    } else if (addKind === "desktop") {

      const path = addPath.trim();

      if (!path || path.length > 1024 || /[\u0000-\u001f]/.test(path)) {

        setAddError("Choose a program file on this computer.");

        return;

      }

      const next = [...customApps, { id: newCustomId("desktop"), name, kind: "desktop" as const, url: "", path }];

      writeCustomApps(next);

      setCustomApps(next);

    } else {

      return;

    }

    setAddKind(null);

    setAddName("");

    setAddUrl("");

    setAddPath("");

    setAddError("");

  }



  async function browseProgram() {

    if (!isTauri()) {

      setAddError("The desktop app can pick a program. You can also type its full path.");

      return;

    }

    try {

      const picked = await pickPaths("program");

      if (picked[0]) {

        setAddPath(picked[0]);

        setAddError("");

      }

    } catch (error) {

      setAddError(errorText(error));

    }

  }



  function removeCustom(id: string) {

    const next = customApps.filter((item) => item.id !== id);

    writeCustomApps(next);

    setCustomApps(next);

    setOpenApp((current) => current?.id === id ? null : current);

    setInstallAsk((current) => current === id ? null : current);

  }



  function hideBuiltinApp(id: string) {

    const next = [...hiddenApps, id];

    writeHiddenApps(next);

    setHiddenApps(next);

    setOpenApp((current) => current?.id === id ? null : current);

    setInstallAsk((current) => current === id ? null : current);

  }



  function setDockTab(tab: DockTab) {

    setDock((prev) => {

      const width = tab === "apps" || prev.width >= 340 ? prev.width : 340;

      dockWidth.current = width;

      const next = { ...prev, tab, width };

      writeDock(next);

      return next;

    });

  }



  function setAppsSide(apps: AppsSide) {

    setAddKind(null);

    setAddName("");

    setAddUrl("");

    setAddPath("");

    setAddError("");

    setDock((prev) => {

      if (prev.apps === apps) return prev;

      const next = { ...prev, apps };

      writeDock(next);

      return next;

    });

  }



  function beginDockDrag(event: ReactPointerEvent<HTMLDivElement>) {

    event.preventDefault();

    const startX = event.clientX;

    const startW = dockWidth.current;

    const previous = document.body.style.userSelect;

    document.body.style.userSelect = "none";

    document.body.dataset.paneDrag = "1";

    let shut = false;

    const move = (pointer: PointerEvent) => {

      const next = startW + (startX - pointer.clientX);

      if (next < 140) {

        shut = true;

        return;

      }

      shut = false;

      const width = clampDock(next);

      dockWidth.current = width;

      setDock((prev) => ({ ...prev, width }));

    };

    const end = () => {

      document.body.style.userSelect = previous;

      delete document.body.dataset.paneDrag;

      window.removeEventListener("pointermove", move);

      window.removeEventListener("pointerup", end);

      if (shut) {

        setDock((prev) => {

          const next = { ...prev, open: false };

          writeDock(next);

          return next;

        });

        return;

      }

      writeDock({ ...dockState.current, open: true, width: dockWidth.current });

    };

    window.addEventListener("pointermove", move);

    window.addEventListener("pointerup", end);

  }



  function beginJobsRevealDrag(event: ReactPointerEvent<HTMLButtonElement>) {

    const start = event.clientX;

    const move = (pointer: PointerEvent) => {

      const next = start - pointer.clientX;

      if (next < 160) return;

      const width = Math.min(640, Math.max(220, Math.round(next)));

      localStorage.setItem("ronic.pane.jobs", String(width));

      setJobsNudge((tick) => tick + 1);

      setJobsOpen(true);

    };

    const end = () => {

      window.removeEventListener("pointermove", move);

      window.removeEventListener("pointerup", end);

    };

    window.addEventListener("pointermove", move);

    window.addEventListener("pointerup", end);

  }



  function beginDockRevealDrag(event: ReactPointerEvent<HTMLButtonElement>) {

    const start = event.clientX;

    const move = (pointer: PointerEvent) => {

      const width = start - pointer.clientX;

      if (width < 160) return;

      const next = clampDock(width);

      dockWidth.current = next;

      setDock((prev) => ({ ...prev, open: true, width: next }));

    };

    const end = () => {

      window.removeEventListener("pointermove", move);

      window.removeEventListener("pointerup", end);

    };

    window.addEventListener("pointermove", move);

    window.addEventListener("pointerup", end);

  }



  async function openDesktop(app: WebApp, kind?: "desktop" | "terminal") {

    setOpenApp(null);

    setDeskSide({ name: app.name, detail: app.path || app.url || "Opens on this computer." });

    revealStage();

    setDeskBusy(app.id);

    setDeskMode(kind ? "install" : "open");

    setDeskNote(kind ? `Installing ${app.name}…` : `Opening ${app.name}…`);

    if (!isTauri()) {

      setDeskBusy(null);

      setDeskNote(`${app.name} installs and opens from the desktop app. This preview cannot launch programs on this computer.`);

      return;

    }

    try {

      const res = await run("launch_desktop_app", {

        id: app.id,

        ...(kind ? { kind } : {}),

        ...(app.custom ? { path: app.path ?? "", name: app.name } : {}),

      });

      if (!res) {

        setDeskNote(useRonic.getState().toast ?? `Could not open ${app.name}.`);

        return;

      }

      if (res.installChoice) {

        setInstallAsk(res.installChoice);

        setDeskNote(res.toast ?? `Choose how to install ${app.name}.`);

      } else {

        setInstallAsk(null);

        setDeskNote(res.toast ?? `Opened ${app.name}.`);

      }

    } finally {

      setDeskBusy(null);

    }

  }



  function chatSnapshot() {

    const lines = snap.steps

      .filter((step) => step.threadId === (thread?.id || snap.activeThreadId) && (step.role === "user" || step.role === "assistant") && step.actionType !== "thinking")

      .slice(-8)

      .map((step) => `${step.role}: ${oneLine(step.contentMarkdown).slice(0, 240)}`)

      .filter(Boolean);

    return lines.length ? lines.join("\n") : "The chat has no messages yet.";

  }



  function appSnapshot() {

    if (openApp) {

      const frame = document.querySelector("[data-app-stage] iframe");

      let visible = "";

      if (frame instanceof HTMLIFrameElement) {

        try { visible = frame.contentDocument?.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 1200) || ""; } catch { visible = ""; }

      }

      return [`App: ${openApp.name}`, `Address: ${openApp.url}`, visible ? `Visible text: ${visible}` : "The page is open beside the chat. Its text is not readable from this side."].join("\n");

    }

    if (deskSide) return `Desktop app: ${deskSide.name}\n${deskSide.detail}\nThe program opens in its own window on this computer.`;

    return "No app is open beside the chat.";

  }



  function rememberScan(title: string, content: string) {

    const botId = accessBot?.id || snap.activeProfileId || null;

    const route = snap.memoryRoutes.find((item) => item.id === (botId ?? "global"));

    const engineId = route?.engineId || snap.memoryRoute?.engineId || "mem0_builtin";

    void run("save_memory", {

      draft: {

        id: null,

        title,

        contentMarkdown: content.slice(0, 4000),

        sourceType: "pane-scan",

        scopedBotId: botId,

        filePathOrUri: "",

        engineId,

      },

    });

  }



  function showThread() {

    const grid = threadBox.current?.parentElement ?? document.querySelector(".chat-grid");

    const gridW = grid?.getBoundingClientRect().width ?? window.innerWidth;

    let room = gridW - 48;

    if (rosterPane.open) room -= rosterPane.width;

    if (browserOpen && pagePane.open) room -= pagePane.width;

    if (screenMode === "preview" && previewPane.open) room -= previewPane.width;

    if (dock.open) room -= dock.width;

    const stageShown = Boolean(openApp || deskSide) && stageMode === "split" && stagePane.open;

    if (stageShown) room -= stagePane.width;

    if (room < 320 && stageShown) stagePane.resize(stagePane.width - (320 - room));

    threadPane.restore();

    if (stageMode === "full" || stageMode === "min") setStageMode("split");

  }



  function placeScan(kind: "chat" | "app") {

    const text = kind === "chat" ? `Visible chat:\n${chatSnapshot()}` : `Visible app:\n${appSnapshot()}`;

    setPrompt(text);

    rememberScan(kind === "chat" ? "Visible chat" : "Visible app", text);

    if (kind === "chat") showThread();

  }



  function splitRoom() {

    const split = document.querySelector(".work-split");

    return split?.clientWidth || Math.max(720, window.innerWidth - 640);

  }



  function stageCap() {

    const room = splitRoom();

    return { room, max: Math.max(340, Math.round(room - 280)) };

  }



  function revealStage() {

    const { room, max } = stageCap();

    const half = Math.round(Math.min(Math.max(340, room * 0.5), max));

    stagePane.resize(half, max);

    setStageMode("split");

  }



  function showStage() {

    const { max } = stageCap();

    const previous = stagePane.width >= 160 ? stagePane.width : max;

    stagePane.resize(Math.min(previous, max), max);

    setStageMode("split");

  }



  function dragStage(event: ReactPointerEvent) {

    event.preventDefault();

    event.stopPropagation();

    const split = (event.currentTarget as HTMLElement).closest(".work-split");

    const start = event.clientX;

    const origin = stagePane.open ? stagePane.width : 0;

    const previous = document.body.style.userSelect;

    document.body.style.userSelect = "none";

    document.body.dataset.paneDrag = "stage";

    const move = (pointer: PointerEvent) => {

      const room = split?.getBoundingClientRect().width ?? splitRoom();

      const max = Math.max(340, Math.round(room - 280));

      const next = origin - (pointer.clientX - start);

      if (next < 150) {

        stagePane.collapse();

        setStageMode("min");

        return;

      }

      stagePane.resize(Math.min(next, max), max);

    };

    const end = () => {

      document.body.style.userSelect = previous;

      delete document.body.dataset.paneDrag;

      window.removeEventListener("pointermove", move);

      window.removeEventListener("pointerup", end);

    };

    window.addEventListener("pointermove", move);

    window.addEventListener("pointerup", end);

  }



  useEffect(() => {

    if (stageMode !== "split" || !stagePane.open || (!openApp && !deskSide)) return;

    const fit = () => {

      const room = splitRoom();

      const max = Math.max(340, Math.round(room - 280));

      if (stagePane.width > max + 4) stagePane.resize(Math.min(stagePane.width, max), max);

    };

    fit();

    window.addEventListener("resize", fit);

    return () => window.removeEventListener("resize", fit);

  }, [openApp, deskSide, stageMode, stagePane.open, stagePane.width]);



  async function send(customText?: string, customFiles?: string[], forceSend?: boolean) {

    let text = (typeof customText === "string" ? customText : prompt).trim();

    if (/\b(scan|look at|see|read)\b/i.test(text) && /\b(screen|app|page|chat|pane|other|webapp|desktop)\b/i.test(text)) {

      text = `${text}\n\nVisible chat:\n${chatSnapshot()}\n\nVisible app:\n${appSnapshot()}`;

    }

    const attachments = customFiles ?? files;

    if ((!text && attachments.length === 0) || !model) return;



    // If bot is already working and this is not a forceful send, queue the message

    if ((sending.current || busy) && !forceSend) {

      queueMessage(text, attachments);

      if (!customText) {

        setPrompt("");

        setFiles([]);

      }

      return;

    }



    const ticket = useRonic.getState().generation;

    sending.current = true;

    setChatError(null);

    setLastSentPrompt(text);

    setLastSentFiles(attachments);



    // 1. Immediate optimistic display (0ms screen lag)

    const optimisticId = `optimistic_${Date.now()}`;

    const optimisticStep: Step = {

      id: optimisticId,

      threadId: thread?.id || snap.activeThreadId || "active",

      role: "user",

      modelUsed: "",

      contentMarkdown: text,

      actionType: "message",

      actionPayload: attachments.length > 0 ? { attachments } : {},

      executionLatencyMs: 0,

      createdAt: Date.now(),

    };



    // 2. Optimistic step appears instantly; the live pill shows the real

    // tool/turn activity streamed back through snapshot.turnActivity.

    setOptimisticSteps((prev) => [...prev, optimisticStep]);



    if (!customText) {

      setPrompt("");

      setFiles([]);

    }

    setSkillsOpen(false);

    setPluginsOpen(false);

    setPlusOpen(false);

    setMenuOpen(false);



    requestAnimationFrame(() => scrollToBottom(true));



    const approvalMode = useRonic.getState().approvalMode;



    try {

      const res = await run("send_message", {

        prompt: text,

        providerId: model.providerId,

        model: model.upstreamModel,

        modelId: model.id,

        effort: effortFor(model.id),

        attachments,

        approvalMode,

      });

      if (!res) {

        const storeToast = useRonic.getState().toast;

        if (storeToast && /fail|error|denied|refused|stopped|unable|no connected model|not found|not ready/i.test(storeToast)) {

          setChatError(storeToast);

        }

      }

    } catch (err: unknown) {

      const msg = err instanceof Error ? err.message : String(err);

      setChatError(msg || "Error executing request");

    } finally {

      sending.current = false;

      // Process queued messages after current one completes

      processQueue();

    }

  }



  function processQueue() {

    const next = dequeueMessage();

    if (next) {

      // Small delay to let UI breathe

      setTimeout(() => {

        void send(next.text, next.files);

      }, 100);

    }

  }



  useEffect(() => {

    if (!busy && !sending.current && messageQueue.length > 0) {

      processQueue();

    }

  }, [busy, messageQueue.length]);



  function closeTab(id: string) {

    setOpenTabs((prev) => {

      const next = prev.filter((item) => item !== id);

      writeTabs(next);

      if (id === snap.activeThreadId) {

        const index = prev.indexOf(id);

        const neighbor = next[Math.max(0, index - 1)];

        if (neighbor) void run("select_thread", { threadId: neighbor });

      }

      return next;

    });

  }



  function runJob(threadId: string) {

    if (!model) return;

    markFired(threadId, Date.now());

    void run("run_routine", { threadId, providerId: model.providerId, model: model.upstreamModel, modelId: model.id, effort: effortFor(model.id) });

  }



  function chooseModel(id: string) {

    setModelId(id);

    try {

      if (id) localStorage.setItem(MODEL_KEY, id);

      else localStorage.removeItem(MODEL_KEY);

    } catch {

      /* the menu still uses the in-memory choice */

    }

    const next = models.find((item) => item.id === id);

    if (!next) return;

    if (thread) void run("set_thread_model", { threadId: thread.id, providerId: next.providerId });

  }



  function openProfile(id: string) {

    setOpenApp(null);

    setProfileBotId(id);

  }



  function openKeyPage(url: string) {

    void openHarnessWindow("apikeys", url);

  }



  function continueChatGpt() {

    setMenuOpen(true);

    void run("sign_in_chatgpt").then((result) => {

      if (!result) {

        setMenuStatus("Restart Ronic OS, then use Continue with ChatGPT. This window was started before that sign-in existed.");

        return;

      }

      const toast = result.toast ?? "";

      if (toast) setMenuStatus(toast);

      if (toast.startsWith("Signed in with ChatGPT")) {

        setFocusGroup("ChatGPT");

        setFocusTick((tick) => tick + 1);

      }

    });

  }



  function openProviderSite(siteId: string) {

    const app = WEB_APPS.find((item) => item.id === siteId);

    if (!app) return;

    setMenuOpen(false);

    setProfileBotId("");

    setDeskSide(null);

    revealStage();

    setFocusNonce((tick) => tick + 1);

    setOpenApp(app);

  }



  return (

    <div className="screen bot-app">

      <div className="chat-layout chat-grid">

        {rosterPane.open ? (

          <div className="chat-col roster-col" style={{ width: rosterPane.width, flex: `0 0 ${rosterPane.width}px` }}>

            <CoworkerSidebar onInspect={setInspectedId} onEditProfile={openProfile} />

          </div>

        ) : <PaneButton label="Bots" onOpen={rosterPane.restore} onDrag={(event) => rosterPane.drag(event, 1)} />}

        <PaneEdge label="Bots" onDrag={(event) => rosterPane.drag(event, 1)} />

        <div className="work-split">

        {threadPane.open && stageMode !== "full" ? (

        <section ref={threadBox} className={`pane thread ${screenMode === "takeover" ? "covering" : ""}`} data-pane="thread">

          <div className="chat-tabs" data-chat-tabs>

            {openTabs.filter((id) => snap.threads.some((item) => item.id === id)).map((id) => {

              const item = snap.threads.find((threadItem) => threadItem.id === id);

              const title = item?.title || "Chat";

              const on = id === snap.activeThreadId;

              return (

                <div key={id} className={`chat-tab ${on ? "on" : ""}`}>

                  <button type="button" onClick={() => void run("select_thread", { threadId: id })}>{title}</button>

                  <button type="button" className="x" aria-label={`Close ${title}`} onClick={() => closeTab(id)}><X size={12} /></button>

                </div>

              );

            })}

            <button type="button" className="chat-tab-add" aria-label="New chat" disabled={busy || snap.profiles.length === 0} onClick={() => void run("create_thread", { title: "" })}><Plus size={14} /></button>

          </div>

          {screenMode === "takeover" && !openApp ? (

            <ComputerDock

              inspectedId={inspected?.id ?? ""}

              onInspect={setInspectedId}

              onClose={() => setScreenMode("closed")}

              onCover={(on) => setScreenMode(on ? "takeover" : "preview")}

              onRunRoutine={thread && model ? () => void run("run_routine", { threadId: thread.id, providerId: model.providerId, model: model.upstreamModel, modelId: model.id, effort: effortFor(model.id) }) : undefined}

              initialTab={screenDockTab}

            />

          ) : (

          <>

          <div className="bot-head">

            {activeGroup ? (

              <span className="face-stack">

                {activeGroup.memberBotIds.slice(0, 3).map((id) => {

                  const member = snap.profiles.find((item) => item.id === id);

                  if (!member) return null;

                  return (

                    <button key={id} type="button" className="face-btn" title={`Edit ${botName(member)}`} aria-label={`Edit ${botName(member)}`} onClick={() => openProfile(id)}>

                      <BotFace seed={member.id} mark={member.avatar} size={28} state={botPresence(member)} />

                    </button>

                  );

                })}

              </span>

            ) : accessBot ? (

              <button type="button" className="face-btn" title={`Edit ${botName(accessBot)}`} aria-label={`Edit ${botName(accessBot)}`} onClick={() => openProfile(accessBot.id)}>

                <BotFace seed={accessBot.id} mark={accessBot.avatar} state={botPresence(accessBot)} />

              </button>

            ) : null}

            <div className="who">

              <strong>{talkTo}</strong>

              {isWorking ? (

                <span className="live-working-badge" title={liveDetail || displayActivity}>

                  <span className="live-pulse-dot" />

                  <span>{displayActivity}</span>

                  {liveDetail && liveDetail !== displayActivity ? <span className="live-working-subtext">{liveDetail}</span> : null}

                </span>

              ) : (

                <span>{activeGroup ? (activeGroup.purpose || modeLabel(activeGroup.coordinationMode)) : (accessBot?.statusLine || accessBot?.role || "Ready for tasks")}</span>

              )}

            </div>

            {activeGroup ? (

              <select className="mode-line" aria-label="How this group works" value={activeGroup.coordinationMode} onChange={(event) => void run("set_group_mode", { groupId: activeGroup.id, mode: event.target.value })}>

                {MODES.map((item) => <option key={item[0]} value={item[0]}>{item[1]}</option>)}

              </select>

            ) : null}

            <button type="button" className="text-btn" onClick={() => setChatsOpen((open) => !open)}>{tasks.length === 1 ? "1 chat" : `${tasks.length} chats`}</button>

            {chatsOpen ? (

              <div className="chat-pop">

                {tasks.map((item) => (

                  <button key={item.id} type="button" className={item.id === thread?.id ? "on" : ""} onClick={() => { setChatsOpen(false); void run("select_thread", { threadId: item.id }); }}>{item.title}</button>

                ))}

                <button type="button" disabled={busy || snap.profiles.length === 0} onClick={() => { setChatsOpen(false); void run("create_thread", { title: "" }); }}>New chat</button>

              </div>

            ) : null}

            <button

              type="button"

              className="btn small refresh-btn"

              disabled={recovering || refreshing}

              aria-label="Refresh chat"

              title="Clear stuck replies, reconnect models, and fix rendering glitches (Ctrl+Shift+R)"

              onClick={() => void handleRefreshChat()}

            >

              <RefreshCw size={13} className={recovering || refreshing ? "spin" : ""} />

              <span>{recovering || refreshing ? "Refreshing…" : "Refresh"}</span>

            </button>

            {openApp || deskSide ? (

              <button type="button" className="btn ghost small" title="Read the app beside this chat and put it in the message box" onClick={() => placeScan("app")}>Scan app</button>

            ) : null}

            <button

              type="button"

              className={`screen-btn ${browserOpen ? "on" : ""}`}

              title="Browser"

              aria-label="Browser"

              aria-pressed={browserOpen}

              onClick={() => setBrowserOpen((open) => !open)}

            >

              <Globe size={16} />

            </button>

            <button

              type="button"

              className={`screen-btn ${screenMode !== "closed" || accessBot?.takeover ? "on" : ""}`}

              title={accessBot?.takeover ? "Open their mini computer. They are waiting for you." : "Open mini computer"}

              aria-label={accessBot?.takeover ? "Open their mini computer; they are waiting for you" : "Open mini computer"}

              onClick={() => {

                setScreenDockTab("computer");

                setScreenMode((mode) => (mode === "closed" ? (accessBot?.takeover ? "takeover" : "preview") : mode === "preview" && screenDockTab === "computer" ? "closed" : mode === "takeover" ? "preview" : mode));

              }}

            >

              <ScreenMark />

            </button>

            <button

              type="button"

              className={`screen-btn ${terminal ? "on" : ""}`}

              title="Toggle Global Terminal (Ctrl+` or Cmd+`)"

              aria-label="Toggle Global Terminal"

              onClick={() => setTerminal(!terminal)}

            >

              <TerminalIcon size={16} />

            </button>

          </div>

          <div className="pane-b transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>

            {snap.skillProposals.filter((item) => item.profileId === profile?.id && item.status === "pending").map((proposal) => (

              <div key={proposal.id} className="notice stack">

                <strong>{profile?.handle} wants to write /{proposal.slug}</strong>

                <p className="muted">{proposal.description || "Approve the write to save the skill."}</p>

                <pre className="pre">{proposedDiff(proposal.currentBody, proposal.proposedBody)}</pre>

                <div className="row-actions">

                  <button type="button" className="btn small" disabled={busy} onClick={() => void run("resolve_skill_proposal", { id: proposal.id, approve: true })}>Approve write</button>

                  <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("resolve_skill_proposal", { id: proposal.id, approve: false })}>Reject</button>

                </div>

              </div>

            ))}

            {!thread ? (

              <div className="empty-hero">

                <span className="empty-hero-glyph" aria-hidden="true">

                  <Sparkles size={16} />

                </span>

                <strong className="empty-hero-title">{accessBot ? `Say hello to ${botName(accessBot)}` : "Your workspace is ready"}</strong>

                <p className="muted">{accessBot ? `Message ${botName(accessBot)} the way you would a teammate. “You are my …” sets the job. “Rename to …” changes the name.` : "Add a bot, then send them the work."}</p>

              </div>

            ) : null}

            {groupedTurns.map((turn) => {

              const chunks = chunkTurnSteps(turn.steps);

              const turnAskedPdf = turn.steps.some(

                (s) => s.role === "user" && /\b(pdf|report|export|download as pdf|save as pdf|generate pdf)\b/i.test(s.contentMarkdown)

              );

              return (

                <div key={turn.id} className="turn">

                  {chunks.map((chunk) => {

                    if (chunk.kind === "process") {

                      return <ProcessStepsCollapse key={chunk.id} steps={chunk.steps} />;

                    }

                    const step = chunk.step;

                    return step.actionType === "gateway_approval" ? (

                      <GatewayCard key={step.id} step={step} model={model} />

                    ) : step.actionType === "bot_handoff" ? (

                      <HandoffLine key={step.id} step={step} />

                    ) : (

                      <StepView key={step.id} step={step} userRequestedPdf={turnAskedPdf} onReply={handleReply} />

                    );

                  })}

                </div>

              );

            })}

            {thread && allSteps.length === 0 && !isWorking ? (

              <div className="empty-hero slim">

                <span className="empty-hero-glyph" aria-hidden="true">

                  <Sparkles size={14} />

                </span>

                <strong className="empty-hero-title">Nothing here yet</strong>

                <p className="muted">Send the first message and the work starts.</p>

              </div>

            ) : null}



            {/* Active Live Background Activity Motion Pill */}

            {isWorking && (

              <div className="chat-live-status-row">

                <div className="chat-live-status-stack">

                  <div className="chat-live-status-pill">

                    <span className="typing-dots" aria-hidden="true">

                      <i />

                      <i />

                      <i />

                    </span>

                    <span className="live-status-text">{displayActivity}</span>

                  </div>

                  {liveDetail && liveDetail !== displayActivity ? <span className="live-status-detail">{liveDetail}</span> : null}

                </div>

              </div>

            )}



            {/* Queued Messages Section */}

            {messageQueue.length > 0 && (

              <div className="chat-queued-section">

                <div className="chat-live-status-pill queued">

                  <span className="queued-icon">⏳</span>

                  <span className="queued-text">

                    <strong>{messageQueue.length} queued {messageQueue.length === 1 ? "message" : "messages"}</strong> (auto-delivers when bot finishes background work)

                  </span>

                  <button

                    type="button"

                    className="queued-clear-btn"

                    onClick={() => useRonic.getState().clearQueue()}

                    title="Clear all queued messages"

                  >

                    Clear All

                  </button>

                </div>

                <div className="chat-queued-list">

                  {messageQueue.map((item, idx) => (

                    <div key={item.id || idx} className="chat-queued-card">

                      <div className="chat-queued-card-body">

                        <span className="chat-queued-badge">Queued #{idx + 1}</span>

                        <p className="chat-queued-card-text">{item.text}</p>

                        {item.files?.length ? (

                          <div className="chat-queued-files">

                            {item.files.map((f: string) => (

                              <span key={f} className="chat-queued-file-pill">📎 {f.split(/[/\\]/).pop()}</span>

                            ))}

                          </div>

                        ) : null}

                      </div>

                      <div className="chat-queued-actions" style={{ display: "flex", alignItems: "center" }}>

                        <button

                          type="button"

                          className="chat-queued-force-btn"

                          onClick={() => {

                            useRonic.getState().removeFromQueue(item.id);

                            void send(item.text, item.files, true);

                          }}

                          title="Force send this queued message immediately"

                        >

                          ⚡ Send Now

                        </button>

                        <button

                          type="button"

                          className="chat-queued-remove-btn"

                          onClick={() => useRonic.getState().removeFromQueue(item.id)}

                          title="Remove this message from queue"

                        >

                          ×

                        </button>

                      </div>

                    </div>

                  ))}

                </div>

              </div>

            )}



            {/* Inline Error Message Pill in Red */}

            {chatError && (

              <div className="chat-live-status-row">

                <div className="chat-live-status-pill error">

                  <AlertCircle size={12} className="live-error-icon" />

                  <span className="live-error-text">{chatError}</span>

                  {lastSentPrompt && (

                    <button

                      type="button"

                      className="live-retry-btn"

                      onClick={() => void send(lastSentPrompt, lastSentFiles)}

                    >

                      Retry

                    </button>

                  )}

                </div>

              </div>

            )}

          </div>

          {showScrollBottom && (

            <button

              type="button"

              className="chat-scroll-down-btn"

              onClick={() => scrollToBottom(true)}

              title="Scroll down to latest chat"

              aria-label="Scroll down to latest chat"

            >

              <ChevronDown size={18} strokeWidth={2.4} />

            </button>

          )}

          <form

            className="composer"

            onSubmit={(event) => {

              event.preventDefault();

              void send();

            }}

          >

            {files.length > 0 ? (

              <div className="chips">

                {files.map((file) => {

                  const name = file.split(/[\\/]/).pop() || file;

                  const ext = name.split(".").pop()?.toLowerCase() || "";

                  const isImg = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext);

                  const isFolder = !ext || ext === name;

                  const FileIcon = isImg ? Image : isFolder ? Folder : FileText;

                  return (

                    <span key={file} className="chip chip-with-icon" title={file}>

                      <FileIcon size={12} className="chip-icon" />

                      <span className="chip-name">{name}</span>

                      <button type="button" aria-label={`Remove ${name}`} onClick={() => setFiles((prev) => prev.filter((item) => item !== file))}>×</button>

                    </span>

                  );

                })}

              </div>

            ) : null}

            {files.length > 0 && !isTauri() ? <p className="muted attach-note">This preview cannot read files on disk. Open the desktop app to include their contents.</p> : null}

            <div className="grok-box">

              <textarea ref={textareaRef} rows={1} className="area"

                placeholder={

                  isWorking

                    ? `Bot is working in background. Type message to queue for ${talkTo}…`

                    : model

                    ? `Message ${talkTo}`

                    : sessionHint

                }

                value={prompt}

                onChange={(event) => setPrompt(event.target.value)}

                onKeyDown={(event) => {

                  if (event.key === "Enter" && !event.shiftKey) {

                    event.preventDefault();

                    if (event.ctrlKey) {

                      void send(undefined, undefined, true);

                    } else {

                      event.currentTarget.form?.requestSubmit();

                    }

                  }

                }}

              />

              <div className="composer-bar">

                <div className="row-actions">

                  <input

                    ref={fileRef}

                    type="file"

                    multiple

                    hidden

                    onChange={(event) => {

                      const names = Array.from(event.target.files ?? []).map((file) => file.name);

                      if (names.length) setFiles((prev) => [...prev, ...names.filter((name) => !prev.includes(name))]);

                      event.target.value = "";

                    }}

                  />

                  <button type="button" className="plus-btn" aria-label="Add" aria-expanded={plusOpen} onClick={() => { setMenuOpen(false); setPlusOpen((open) => !open); }}>+</button>

                  <SuperchargeControl compact />

                  <ApprovalModeControl />

                  <button type="button" className="model-trigger" data-model-trigger aria-haspopup="listbox" aria-expanded={menuOpen} onClick={() => { setPlusOpen(false); setMenuMode("list"); setMenuOpen(true); }}>

                    {model?.label ?? (models.length ? `Select a model (${models.length})` : "Select a model")}

                  </button>

                  {model ? (

                    <button type="button" className="model-trigger" data-model-trigger onClick={() => { setPlusOpen(false); setMenuMode("list"); setMenuOpen(true); }}>

                      {effort === "default" ? "Default" : effort === "xhigh" ? "XHigh" : effort[0].toUpperCase() + effort.slice(1)}

                    </button>

                  ) : null}

                </div>

                <div className="send-side">

                  <MicButton disabled={busy} onText={(text) => setPrompt((value) => value.trim() ? `${value.trim()} ${text}` : text)} onError={(message) => setChatError(message)} />

                  {isWorking && (

                    <button

                      type="button"

                      className="force-send-btn"

                      aria-label="Force send immediately"

                      title="Force send immediately (bypass queue / interrupt)"

                      disabled={!model || (prompt.trim().length === 0 && files.length === 0)}

                      onClick={() => void send(undefined, undefined, true)}

                    >

                      ⚡ Force

                    </button>

                  )}

                  <button

                    className={`send-round ${isWorking ? "queue-mode" : ""}`}

                    aria-label={isWorking ? "Queue message" : "Send"}

                    title={isWorking ? "Queue message (will send when current task finishes)" : "Send"}

                    disabled={!model || (prompt.trim().length === 0 && files.length === 0)}

                  >

                    {isWorking ? "⏳" : "↑"}

                  </button>

                </div>

              </div>

              {plusOpen ? (

                <div className="plus-menu">

                   <button type="button" onClick={() => { if (!isTauri()) { fileRef.current?.click(); setPlusOpen(false); return; } void pickPaths("files").then((paths) => { if (paths.length) setFiles((prev) => [...prev, ...paths.filter((path) => !prev.includes(path))]); }); setPlusOpen(false); }}>Attach Files</button>

                   <button type="button" onClick={() => { if (!isTauri()) { setPlusOpen(false); return; } void pickPaths("folder").then((paths) => { if (paths.length) setFiles((prev) => [...prev, ...paths.filter((path) => !prev.includes(path))]); }); setPlusOpen(false); }}>Attach Folder</button>

                  <button type="button" disabled={!accessBot} onClick={() => { if (accessBot) setPrompt((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}${accessBot.handle} `); setPlusOpen(false); }}>Mention {accessBot ? botName(accessBot) : "a bot"}</button>

                  <button type="button" onClick={() => { setPlusOpen(false); setPluginsOpen(false); snap.skills.length ? setSkillsOpen((open) => !open) : go("skills"); }}>Skills</button>

                  <button type="button" onClick={() => { setPlusOpen(false); setSkillsOpen(false); snap.plugins.length ? setPluginsOpen((open) => !open) : go("capabilities"); }}>Plugins</button>

                </div>

              ) : null}

            </div>

            {skillsOpen ? (

              <div className="stack" style={{ marginTop: 8 }}>

                {snap.skills.filter((skill) => accessBot && inIndex(skill, snap.plugins, accessBot.id)).map((skill) => (

                  <button key={skill.id} type="button" className="btn ghost small" onClick={() => { setPrompt((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}${skill.slashCommand} `); setSkillsOpen(false); }}>

                    {skill.slashCommand}

                  </button>

                ))}

              </div>

            ) : null}

            {pluginsOpen ? (

              <div className="stack" style={{ marginTop: 8 }}>

                {snap.plugins.filter((plugin) => accessBot && plugin.agentEnables.some((flag) => flag.profileId === accessBot.id && flag.enabled)).map((plugin) => (

                  <button key={plugin.id} type="button" className="btn ghost small" onClick={() => { setPrompt((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}${plugin.slug} `); setPluginsOpen(false); }}>

                    {plugin.name}

                  </button>

                ))}

                {accessBot && snap.plugins.every((plugin) => !plugin.agentEnables.some((flag) => flag.profileId === accessBot.id && flag.enabled)) ? <p className="muted">No plugins are on for {accessBot.handle}. Turn them on in the computer dock.</p> : null}

              </div>

            ) : null}

            <ModelMenu

              open={menuOpen}

              models={models}

              selectedId={model?.id ?? ""}

              effortOf={effortFor}

              stars={stars}

              status={menuStatus}

              mode={menuMode}

              refreshing={refreshing}

              providers={menuProviders}

              links={links}

              onClose={() => setMenuOpen(false)}

              onSelect={(id) => { chooseModel(id); setMenuOpen(false); }}

              onEffort={(id, next) => { setEffort(id, next); setEffortTick((tick) => tick + 1); }}

              onStar={(id) => setStars(toggleStar(id))}

              onRefresh={() => {

                setRefreshing(true);

                const ids = keyedKey.length ? keyedKey.split("|") : [];

                void loadConnectedModels(ids).then((result) => {

                  const next = catalog(ids, result.ollama);

                  setOllamaReady(result.ollama);

                  setModels(next);

                  setModelId((current) => next.some((item) => item.id === current) ? current : (next[0]?.id ?? ""));

                  setMenuStatus(result.notes.join(" "));

                }).catch((error) => {

                  setMenuStatus(errorText(error));

                }).finally(() => setRefreshing(false));

              }}

              onMode={setMenuMode}

              onCreate={(draft) => {

                const created = addCustom(draft);

                const next = catalog(keyedIds, ollamaReady);

                setModels(next);

                setModelId(next.some((item) => item.id === created.id) ? created.id : (next[0]?.id ?? ""));

                if (thread) void run("set_thread_model", { threadId: thread.id, providerId: created.providerId });

                setMenuMode("list");

                setMenuStatus(next.some((item) => item.id === created.id) ? `Added ${created.label}. Sending uses ${created.upstreamModel}.` : `${created.label} is saved. It appears after that provider has a key.`);

              }}

              onSaveEdit={(id, patch) => {

                saveEdit(id, patch);

                setModels(catalog(keyedIds, ollamaReady));

                setMenuStatus("Model saved. The next send uses the edited id.");

              }}

              onHide={(id) => {

                hideModel(id);

                const next = catalog(keyedIds, ollamaReady);

                setModels(next);

                setModelId((current) => current === id ? (next[0]?.id ?? "") : current);

              }}

              onSignIn={openProviderSite}

              onOpenKeys={openKeyPage}

              onContinueChatGpt={continueChatGpt}

              focusGroup={focusGroup}

              focusTick={focusTick}

              onSaveKey={(id, secret) => {

                void run("set_provider_secret", { id, secret }).then((result) => {

                  if (result?.toast) setMenuStatus(result.toast);

                });

              }}

            />

          </form>

</>

          )}

          {profileBot ? (

            <ProfileSlide

              bot={profileBot}

              providers={snap.providers}

              links={links}

              onClose={() => setProfileBotId("")}

              onSignIn={openProviderSite}

              onOpenKeys={openKeyPage}

              onContinueChatGpt={continueChatGpt}

              onSaveKey={(id, secret) => { void run("set_provider_secret", { id, secret }); }}

            />

          ) : null}

        </section>

        ) : !threadPane.open ? <PaneButton label="Chat" onOpen={showThread} onDrag={(event) => threadPane.drag(event, 1, "thread")} /> : null}

        {openApp && stageMode === "full" ? (

          <div className="chat-col stage-col full" data-app-stage data-stage-mode="full">

            <WebStage

              app={openApp}

              known={installed.includes(openApp.id)}

              focusNonce={focusNonce}

              onInstalled={rememberInstalled}

              full

              onClose={() => { setOpenApp(null); setStageMode("split"); }}

              onMinimize={() => { stagePane.collapse(); setStageMode("min"); }}

              onToggleFull={() => setStageMode("split")}

              onScanChat={() => placeScan("chat")}

            />

          </div>

        ) : openApp && stageMode !== "min" && stagePane.open ? (

          <>

            <PaneEdge label="App" onDrag={(event) => dragStage(event)} />

            <div className="chat-col stage-col" data-app-stage data-stage-mode="split" style={{ width: stagePane.width, flex: `0 0 ${stagePane.width}px` }}>

              <WebStage

                app={openApp}

                known={installed.includes(openApp.id)}

                focusNonce={focusNonce}

                onInstalled={rememberInstalled}

                full={false}

                onClose={() => { setOpenApp(null); setStageMode("split"); }}

                onMinimize={() => { stagePane.collapse(); setStageMode("min"); }}

                onToggleFull={() => setStageMode("full")}

                onScanChat={() => placeScan("chat")}

              />

            </div>

          </>

        ) : openApp ? <PaneButton label={openApp.name} onOpen={showStage} onDrag={(event) => dragStage(event)} /> : null}

        {!openApp && deskSide && stageMode !== "min" && stagePane.open ? (

          <>

            <PaneEdge label="Desktop app" onDrag={(event) => dragStage(event)} />

            <div className="chat-col stage-col" data-app-stage data-stage-mode="desktop" style={{ width: stagePane.width, flex: `0 0 ${stagePane.width}px` }}>

              <div className="pane-h between stage-head">

                <strong>{deskSide.name}</strong>

                <div className="stage-actions">

                  <button type="button" className="btn ghost small" onClick={() => placeScan("chat")}>Scan chat</button>

                  <button type="button" className="btn ghost small" aria-label="Minimize app" title="Minimize" onClick={() => { stagePane.collapse(); setStageMode("min"); }}><Minus size={14} /></button>

                  <button type="button" className="btn ghost small" aria-label="Close app" title="Close" onClick={() => { setDeskSide(null); setStageMode("split"); }}><X size={14} /></button>

                </div>

              </div>

              <div className="pane-b stack">

                <p>{deskSide.detail}</p>

                <p className="muted">The program opens in its own window. This pane stays beside the chat so you can keep talking. Scan chat puts the conversation in the message box.</p>

              </div>

            </div>

          </>

        ) : !openApp && deskSide ? <PaneButton label={deskSide.name} onOpen={showStage} onDrag={(event) => dragStage(event)} /> : null}

        </div>

        {browserOpen && pagePane.open ? (

          <>

            <PaneEdge label="Page" onDrag={(event) => pagePane.drag(event, -1)} />

            <div className="chat-col page-col" style={{ width: pagePane.width, flex: `0 0 ${pagePane.width}px` }}>

            <LiveBrowser

              botName={talkTo}

              onClose={() => setBrowserOpen(false)}

              onAsk={(text) => {

                if (model) {

                  void send(text);

                  return;

                }

                setPrompt(text);

                setChatError("Choose a model, then send this.");

              }}

            />

          </div>

          </>

        ) : browserOpen ? <PaneButton label="Page" onOpen={pagePane.restore} onDrag={(event) => pagePane.drag(event, -1)} /> : null}

        {screenMode === "preview" && previewPane.open ? (

          <>

            <PaneEdge label="Computer" onDrag={(event) => previewPane.drag(event, -1)} />

            <div className="chat-col preview-col" style={{ width: previewPane.width, flex: `0 0 ${previewPane.width}px` }}>

            <ComputerDock

              inspectedId={inspected?.id ?? ""}

              onInspect={setInspectedId}

              onClose={() => setScreenMode("closed")}

              onCover={(on) => setScreenMode(on ? "takeover" : "preview")}

              onRunRoutine={thread && model ? () => void run("run_routine", { threadId: thread.id, providerId: model.providerId, model: model.upstreamModel, modelId: model.id, effort: effortFor(model.id) }) : undefined}

              initialTab={screenDockTab}

            />

            </div>

          </>

        ) : screenMode === "preview" ? <PaneButton label="Computer" onOpen={previewPane.restore} onDrag={(event) => previewPane.drag(event, -1)} /> : null}

        {dock.open ? (

        <aside className="pane chat-side" style={{ width: dock.width, flex: `0 0 ${dock.width}px` }}>

          <div

            className="dock-handle"

            title="Drag to resize. Double-click to reset."

            onPointerDown={beginDockDrag}

            onDoubleClick={() => {

              dockWidth.current = 280;

              setDock((prev) => {

                const next = { ...prev, width: 280 };

                writeDock(next);

                return next;

              });

            }}

          />

          <div className="pane-h dock-head">

            <div className="dock-tabs" role="tablist">

              <button type="button" role="tab" aria-selected={dock.tab === "apps"} className={dock.tab === "apps" ? "btn small" : "btn ghost small"} onClick={() => setDockTab("apps")}>Apps</button>

              <button type="button" role="tab" aria-selected={dock.tab === "accounts"} className={dock.tab === "accounts" ? "btn small" : "btn ghost small"} onClick={() => setDockTab("accounts")}>Accounts</button>

              <button type="button" role="tab" aria-selected={dock.tab === "capabilities"} className={dock.tab === "capabilities" ? "btn small" : "btn ghost small"} onClick={() => setDockTab("capabilities")}>Capabilities</button>

            </div>

            <button type="button" className="btn ghost small" onClick={() => setDockOpen(false)}>Hide</button>

          </div>

          <div className="pane-b stack dock-pane">

            {dock.tab === "accounts" ? (

              <DockAccounts

                models={models}

                selectedId={model?.id ?? ""}

                ollamaReady={ollamaReady}

                onOpenSite={(app) => { setDeskSide(null); revealStage(); setFocusNonce((tick) => tick + 1); setOpenApp(app); }}

                onSelectModel={chooseModel}

                onModelsChanged={(id) => {

                  const ids = keyedKey.length ? keyedKey.split("|") : [];

                  const next = catalog(ids, ollamaReady);

                  setModels(next);

                  if (id && next.some((item) => item.id === id)) setModelId(id);

                }}

              />

            ) : null}

            {dock.tab === "capabilities" ? (

              <DockCapabilities onUseSkill={(slash) => setPrompt((current) => current.trim() ? `${current.trim()} ${slash}` : slash)} />

            ) : null}

            {dock.tab === "apps" ? (

            <>

            <div className="dock-switch" role="tablist" aria-label="Web apps or desktop apps">

              <button type="button" role="tab" aria-selected={dock.apps === "web"} className={dock.apps === "web" ? "btn small" : "btn ghost small"} onClick={() => setAppsSide("web")}>Web</button>

              <button type="button" role="tab" aria-selected={dock.apps === "desktop"} className={dock.apps === "desktop" ? "btn small" : "btn ghost small"} onClick={() => setAppsSide("desktop")}>Desktop</button>

            </div>

            {dock.apps === "web" ? (

            <>

            <div className="between">

              <strong>Web apps</strong>

              <div className="row-actions">

                <button type="button" className="btn ghost small" onClick={() => toggleAdd("web")}>{addKind === "web" ? "Close" : "Add"}</button>

                <button type="button" className="btn ghost small" disabled={busy || !selectedProvider} onClick={() => selectedProvider && void run("test_provider", { id: selectedProvider.id })}>Test ping</button>

              </div>

            </div>

            {addKind === "web" ? (

              <div className="dock-add">

                <label className="field"><span>Name</span><input className="input" value={addName} placeholder="Name" onChange={(event) => setAddName(event.target.value)} /></label>

                <label className="field"><span>Address</span><input className="input" value={addUrl} placeholder="muse.ai" onChange={(event) => setAddUrl(event.target.value)} /></label>

                <div className="row-actions">

                  <button type="button" className="btn small" onClick={saveAdded}>Save</button>

                  <button type="button" className="btn ghost small" onClick={() => toggleAdd("web")}>Cancel</button>

                </div>

                {addError ? <p className="muted">{addError}</p> : <p className="muted">A site address opens in this panel. http works only for localhost.</p>}

              </div>

            ) : null}

            <div className="app-dock">

              {[...WEB_APPS, ...addedWeb].filter((app) => !hiddenApps.includes(app.id)).map((app) => (

                <div key={app.id} className="dock-tile">

                  <button type="button" className={`dock-btn ${openApp?.id === app.id ? "on" : ""}`} title={installed.includes(app.id) ? `Open ${app.name} inside Ronic OS` : `Install ${app.name}, then open it inside Ronic OS`} onClick={() => { setDeskSide(null); revealStage(); setFocusNonce((tick) => tick + 1); setOpenApp(app); }}>

                    {installed.includes(app.id) ? <i className="dock-badge" /> : null}

                    <AppLogo id={app.id} name={app.name} mark={app.mark} url={app.custom ? app.url : undefined} />

                    <span className="dock-label">{app.name}</span>

                  </button>

                  <button type="button" className="dock-remove" aria-label={`Remove ${app.name}`} onClick={() => app.custom ? removeCustom(app.id) : hideBuiltinApp(app.id)}>×</button>

                </div>

              ))}

            </div>

            </>

            ) : (

            <>

            <div className="between">

              <strong>Desktop</strong>

              <button type="button" className="btn ghost small" onClick={() => toggleAdd("desktop")}>{addKind === "desktop" ? "Close" : "Add"}</button>

            </div>

            {addKind === "desktop" ? (

              <div className="dock-add">

                <label className="field"><span>Name</span><input className="input" value={addName} placeholder="Name" onChange={(event) => setAddName(event.target.value)} /></label>

                <label className="field"><span>Program</span><input className="input" value={addPath} placeholder="C:\Path\App.exe" onChange={(event) => setAddPath(event.target.value)} /></label>

                <div className="row-actions">

                  <button type="button" className="btn small" onClick={saveAdded}>Save</button>

                  <button type="button" className="btn ghost small" onClick={() => void browseProgram()}>Browse</button>

                  <button type="button" className="btn ghost small" onClick={() => toggleAdd("desktop")}>Cancel</button>

                </div>

                {addError ? <p className="muted">{addError}</p> : <p className="muted">Pick an installed program. It opens on this computer.</p>}

              </div>

            ) : null}

            <div className="app-dock">

              {[...DOWNLOADS, ...addedDesk].filter((app) => !hiddenApps.includes(app.id)).map((app) => {

                const ready = app.custom ? (app.path ?? "").trim().length > 0 : snap.apps.some((item) => item.id === DESK_ROWS[app.id] && item.executablePath.trim().length > 0);

                return (

                  <div key={app.id} className="dock-tile">

                    <button type="button" className="dock-btn" disabled={deskBusy !== null} title={ready ? `Open ${app.name}` : `Choose a desktop app or a terminal app for ${app.name}`} onClick={() => void openDesktop(app)}>

                      {ready ? <i className="dock-badge" /> : null}

                      <AppLogo id={app.id} name={app.name} mark={app.mark} />

                      <span className="dock-label">{deskBusy === app.id ? (deskMode === "install" ? "Installing…" : "Opening…") : app.name}</span>

                    </button>

                    <button type="button" className="dock-remove" aria-label={`Remove ${app.name}`} onClick={() => app.custom ? removeCustom(app.id) : hideBuiltinApp(app.id)}>×</button>

                  </div>

                );

              })}

            </div>

            {deskNote ? <p className="muted">{deskNote}</p> : null}

            {installAsk ? (

              <div className="row-actions">

                <button type="button" className="btn ghost small" disabled={deskBusy !== null} onClick={() => { const app = DOWNLOADS.find((item) => item.id === installAsk); if (app) void openDesktop(app, "desktop"); }}>Desktop app</button>

                {installAsk !== "obsidian" ? <button type="button" className="btn ghost small" disabled={deskBusy !== null} onClick={() => { const app = DOWNLOADS.find((item) => item.id === installAsk); if (app) void openDesktop(app, "terminal"); }}>Terminal app</button> : null}

              </div>

            ) : null}

            </>

            )}

            </>

            ) : null}

          </div>

          <div className={`dock-footer ${dockFooterOpen ? "open" : ""}`}>

            <div className="dock-footer-bar">

              <span className="dock-footer-summary" title={`Daily limit: ${profile?.dailyWalletLimitUsd ?? 0} USD · Spent: ${snap.spentTodayUsd.toFixed(2)} USD`}>

                <span className="dock-footer-dot" />

                <span className="dock-footer-label">

                  Limit ${profile?.dailyWalletLimitUsd ?? 0} · Spent ${snap.spentTodayUsd.toFixed(2)}

                </span>

              </span>

              <button

                type="button"

                className="btn ghost small dock-view-toggle"

                onClick={() => setDockFooterOpen((prev) => !prev)}

                title={dockFooterOpen ? "Close details" : "View full details"}

                aria-label={dockFooterOpen ? "Close details" : "View full details"}

              >

                {dockFooterOpen ? <EyeOff size={13} /> : <Eye size={13} />}

              </button>

            </div>

            {dockFooterOpen ? (

              <div className="dock-footer-details">

                {selectedProvider?.healthDetail ? <pre className="pre ping-out-full">{selectedProvider.healthDetail}</pre> : null}

                <p className="muted">Daily wallet limit {profile?.dailyWalletLimitUsd ?? 0} USD · spent today {snap.spentTodayUsd.toFixed(2)} USD</p>

                <p className="muted">{bridgeNote || "In the desktop app, these web apps and Claude Code, Gemini CLI, and Cursor can use this workspace's skills, plugins, and memory."}</p>

              </div>

            ) : null}

          </div>

        </aside>

        ) : null}

        <ScheduledJobs open={jobsOpen} canRun={Boolean(model)} nudge={jobsNudge} onClose={() => setJobsOpen(false)} onRun={runJob} />

        <aside className="edge-rail" data-edge-rail aria-label="Dock and scheduled jobs">

          {dock.open ? null : <button type="button" className="dock-reveal" onClick={() => setDockOpen(true)} onPointerDown={beginDockRevealDrag}>Dock</button>}

          {jobsOpen ? null : <button type="button" className="jobs-reveal" onClick={() => setJobsOpen(true)} onPointerDown={beginJobsRevealDrag}>Scheduled jobs</button>}

        </aside>

      </div>

    </div>

  );

}



function stageBounds(el: HTMLElement): WebAppBounds | null {

  const rect = el.getBoundingClientRect();

  const stage = el.closest("[data-app-stage]")?.getBoundingClientRect();

  let x = rect.left;

  let y = rect.top;

  let right = rect.right;

  let bottom = rect.bottom;

  if (stage) {

    x = Math.max(x, stage.left);

    y = Math.max(y, stage.top);

    right = Math.min(right, stage.right);

    bottom = Math.min(bottom, stage.bottom);

  }

  const split = el.closest(".work-split");

  if (split) {

    const box = split.getBoundingClientRect();

    x = Math.max(x, box.left);

    y = Math.max(y, box.top);

    right = Math.min(right, box.right);

    bottom = Math.min(bottom, box.bottom);

  }

  const thread = document.querySelector("[data-pane=thread]");

  if (thread) {

    const edge = thread.getBoundingClientRect().right + 8;

    if (x < edge) x = edge;

  }

  for (const selector of ["[data-edge-rail]", "[data-jobs-panel]", ".chat-layout > .chat-side"]) {

    const neighbor = document.querySelector(selector);

    if (!neighbor) continue;

    const edge = neighbor.getBoundingClientRect().left;

    if (edge > 0 && right > edge) right = edge;

  }

  right = Math.min(right, window.innerWidth);

  bottom = Math.min(bottom, window.innerHeight);

  x = Math.max(0, x);

  y = Math.max(0, y);

  const width = right - x;

  const height = bottom - y;

  if (width < 8 || height < 8) return null;

  return { x, y, width, height };

}



function WebStage({ app, known, focusNonce, onInstalled, onClose, onMinimize, onToggleFull, full, onScanChat }: { app: WebApp; known: boolean; focusNonce: number; onInstalled: (id: string) => void; onClose: () => void; onMinimize: () => void; onToggleFull: () => void; full: boolean; onScanChat: () => void }) {

  const slotRef = useRef<HTMLDivElement>(null);

  const shown = useRef(false);

  const placed = useRef("");

  const knownRef = useRef(known);

  const installedRef = useRef(onInstalled);

  knownRef.current = known;

  installedRef.current = onInstalled;

  const [status, setStatus] = useState(known ? `Opening ${app.name}…` : `Installing ${app.name}…`);

  const [failed, setFailed] = useState("");

  const [signInNote, setSignInNote] = useState("");

  const notedAt = useRef(0);



  useEffect(() => {

    const onSignIn = (event: Event) => {

      const detail = (event as CustomEvent<{ id?: string; message?: string }>).detail;

      if (!detail || detail.id !== app.id || !detail.message) return;

      notedAt.current = Date.now();

      setFailed("");

      setSignInNote(detail.message);

      setStatus(detail.message);

    };

    window.addEventListener("ronic-signin", onSignIn);

    return () => window.removeEventListener("ronic-signin", onSignIn);

  }, [app.id]);



  useEffect(() => {

    shown.current = false;

    placed.current = "";

    notedAt.current = 0;

    setFailed("");

    setSignInNote("");

    setStatus(knownRef.current ? `Opening ${app.name}…` : `Installing ${app.name}…`);

    let dead = false;

    let opening = false;

    let failedOpen = false;

    const sync = () => {

      const el = slotRef.current;

      const bounds = el ? stageBounds(el) : null;

      if (!bounds || dead || failedOpen) return;

      if (!isTauri()) {

        if (!shown.current) {

          shown.current = true;

          installedRef.current(app.id);

          setStatus(`${app.name} is installed in this panel.`);

        }

        return;

      }

      const key = `${Math.round(bounds.x)}|${Math.round(bounds.y)}|${Math.round(bounds.width)}|${Math.round(bounds.height)}`;

      if (shown.current) {

        if (placed.current === key) return;

        placed.current = key;

        void placeWorkspaceWebapp(app.id, bounds).catch(() => {});

        return;

      }

      if (opening) return;

      opening = true;

      const started = Date.now();

      const extra = app.custom ? { url: app.url, name: app.name } : undefined;

      void showWorkspaceWebapp(app.id, bounds, true, extra).then((res) => {

        opening = false;

        if (dead) {

          void hideWorkspaceWebapps();

          return;

        }

        shown.current = true;

        placed.current = key;

        installedRef.current(app.id);

        if (res.signing_in) {

          notedAt.current = Date.now();

          setSignInNote(res.signing_in);

          setStatus(res.signing_in);

          return;

        }

        if (notedAt.current > started) return;

        setSignInNote("");

        setStatus("");

        useRonic.setState({ toast: res.note });

      }).catch((error) => {

        opening = false;

        failedOpen = true;

        if (!dead) setFailed(errorText(error));

      });

    };

    const onResize = () => sync();

    let frame2 = 0;

    const frame = requestAnimationFrame(() => {

      sync();

      frame2 = requestAnimationFrame(sync);

    });

    const later = window.setTimeout(sync, 120);

    const observer = new ResizeObserver(sync);

    if (slotRef.current) {

      observer.observe(slotRef.current);

      const stage = slotRef.current.closest("[data-app-stage]");

      if (stage) observer.observe(stage);

    }

    const thread = document.querySelector("[data-pane=thread]");

    if (thread) observer.observe(thread);

    for (const selector of ["[data-edge-rail]", "[data-jobs-panel]", ".chat-layout > .chat-side"]) {

      const neighbor = document.querySelector(selector);

      if (neighbor) observer.observe(neighbor);

    }

    window.addEventListener("resize", onResize);

    return () => {

      dead = true;

      cancelAnimationFrame(frame);

      cancelAnimationFrame(frame2);

      window.clearTimeout(later);

      observer.disconnect();

      window.removeEventListener("resize", onResize);

      void hideWorkspaceWebapps();

    };

  }, [app.id, app.url, app.name, app.custom]);



  useEffect(() => {

    if (!shown.current || !isTauri()) return;

    const el = slotRef.current;

    if (!el) return;

    const bounds = stageBounds(el);

    if (!bounds) return;

    const extra = app.custom ? { url: app.url, name: app.name } : undefined;

    const started = Date.now();

    void showWorkspaceWebapp(app.id, bounds, true, extra).then((res) => {

      if (res.signing_in) {

        notedAt.current = Date.now();

        setSignInNote(res.signing_in);

        setStatus(res.signing_in);

        return;

      }

      if (notedAt.current > started) return;

      setSignInNote("");

    }).catch(() => {});

  }, [app.id, app.url, app.name, app.custom, focusNonce]);



  const page = isTauri() ? null : safePageUrl(app.url);

  return (

    <>

      <div className="pane-h between stage-head">

        <div className="stage-title">

          <strong>{app.name}</strong>

          <span className="muted">{app.url.replace(/^https?:\/\//, "")}</span>

        </div>

        <div className="stage-actions">

          <button type="button" className="btn ghost small" title="Read the chat and put it in the message box" onClick={onScanChat}>Scan chat</button>

          <button type="button" className="btn ghost small" aria-label="Minimize app" title="Minimize" onClick={onMinimize}><Minus size={14} /></button>

          <button type="button" className="btn ghost small" aria-label={full ? "Restore split view" : "Full screen"} title={full ? "Restore split view" : "Full screen"} onClick={onToggleFull}>

            {full ? <Minimize2 size={14} /> : <Square size={14} />}

          </button>

          <button type="button" className="btn ghost small" aria-label="Close app" title="Close" onClick={onClose}><X size={14} /></button>

        </div>

      </div>

      <div className="webapp-slot" ref={slotRef}>

        {page ? <iframe title={app.name} src={page} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" /> : null}

        {failed ? <p className="notice">{failed}</p> : signInNote ? <p className="notice webapp-wait">{signInNote}</p> : page ? null : <p className="muted webapp-wait">{status || `${app.name} is open in this panel.`}</p>}

        {!isTauri() && !page ? <p className="muted">This address cannot be shown in the panel.</p> : null}

      </div>

    </>

  );

}



function ScreenMark() {

  return (

    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>

      <rect x="2" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />

      <path d="M6 15h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />

    </svg>

  );

}



const ProcessStepsCollapse = memo(function ProcessStepsCollapse({ steps }: { steps: Step[] }) {

  const [open, setOpen] = useState(false);



  const toolSteps = steps.filter((s) => s.role === "tool" || s.actionType === "harness2_pipeline");

  const thinkingSteps = steps.filter((s) => s.actionType === "thinking");

  const toolNames = Array.from(

    new Set(

      toolSteps

        .map((s) => (s.actionType === "harness2_pipeline" ? "Supercharge" : s.modelUsed || "tool"))

        .filter(Boolean)

    )

  );

  const previewNames = toolNames.slice(0, 3);

  const remainingCount = toolNames.length - previewNames.length;



  let title = "Process";

  if (toolSteps.length > 0 && thinkingSteps.length > 0) {

    title = `Thinking & ${toolSteps.length} tool call${toolSteps.length > 1 ? "s" : ""}`;

  } else if (toolSteps.length > 0) {

    title = `${toolSteps.length} tool call${toolSteps.length > 1 ? "s" : ""}`;

  } else if (thinkingSteps.length > 0) {

    title = "Thinking";

  }



  const hasPendingDiff = steps.some(

    (s) => s.actionType === "code_diff" && (s.actionPayload as Record<string, unknown>)?.status === "pending"

  );



  return (

    <div className={`process-collapse-card ${open ? "open" : ""}`}>

      <div

        className="process-collapse-header"

        onClick={() => setOpen((prev) => !prev)}

        role="button"

        tabIndex={0}

        onKeyDown={(e) => {

          if (e.key === "Enter" || e.key === " ") {

            e.preventDefault();

            setOpen((prev) => !prev);

          }

        }}

      >

        <div className="process-collapse-left">

          <Brain size={15} className="process-icon" />

          <strong className="process-title">{title}</strong>

          {previewNames.length > 0 && (

            <div className="process-tool-pills">

              {previewNames.map((name) => (

                <span key={name} className="process-tool-pill">

                  {name}

                </span>

              ))}

              {remainingCount > 0 && (

                <span className="process-tool-pill">+{remainingCount} more</span>

              )}

            </div>

          )}

          <span className="process-count">

            ({steps.length} {steps.length === 1 ? "step" : "steps"})

          </span>

          {hasPendingDiff && (

            <span className="process-diff-badge">Diff pending approval</span>

          )}

        </div>

        <button

          type="button"

          className="process-open-btn"

          onClick={(e) => {

            e.stopPropagation();

            setOpen((prev) => !prev);

          }}

          aria-expanded={open}

        >

          <span>{open ? "Hide full" : "Open full"}</span>

          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}

        </button>

      </div>



      {open && (

        <div className="process-collapse-body">

          {steps.map((step) => (

            <StepView key={step.id} step={step} />

          ))}

        </div>

      )}

    </div>

  );

});



const toolSummary = (step: Step) =>

  step.actionType === "workflow" ? "Workflow saved" : step.actionType === "routine" ? "Routine scheduled" : step.modelUsed || "Tool";



function botHeaderLabel(modelUsed?: string) {

  if (!modelUsed) return "Assistant";

  const first = modelUsed.split(/\s*·\s*/)[0].trim();

  return first || "Assistant";

}



const StepView = memo(function StepView({
  step,
  userRequestedPdf,
  onReply,
}: {
  step: Step;
  userRequestedPdf?: boolean;
  onReply?: (content: string, modelUsed?: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(step.contentMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [step.contentMarkdown]);

  if (step.actionType === "harness2_pipeline") {

    return <Harness2PipelineCard step={step} />;

  }

  if (step.actionType === "thinking") {

    return (

      <details className="step thinking">

        <summary>Thinking</summary>

        <p className="step-copy">{step.contentMarkdown}</p>

      </details>

    );

  }

  if (step.actionType === "handoff_capsule" || step.role === "system") {

    return (

      <article className="step capsule">

        <p className="muted step-copy">{step.contentMarkdown}</p>

      </article>

    );

  }

  if (step.role === "user") {

    const cleanContent = cleanUserMessage(step.contentMarkdown);

    return (

      <article className="step user turn-user">

        <p className="step-copy">{cleanContent || step.contentMarkdown}</p>

      </article>

    );

  }

  if (step.role === "tool") {

    const card = step.actionType === "code_diff" || step.actionType === "pty_terminal" || step.actionType === "cdp_browser" || step.actionType === "browser_inspect" || step.actionType === "wallet_tx";

    if (card) {

      return (

        <article className="step tool-card">

          <div className="between">

            <strong>{step.modelUsed || "Tool"}</strong>

            <span className="faint">{step.executionLatencyMs ? `${step.executionLatencyMs} ms` : ""}</span>

          </div>

          <ToolBody step={step} />

        </article>

      );

    }

    return (

      <details className="tool-card">

        <summary>{toolSummary(step)}</summary>

        <p className="step-copy">{step.contentMarkdown}</p>

        {Object.keys(step.actionPayload).length > 0 ? <pre className="pre">{JSON.stringify(step.actionPayload, null, 2)}</pre> : null}

      </details>

    );

  }

      return (
    <article className="step assistant-response relative group">
      <div className="between">
        <strong>{botHeaderLabel(step.modelUsed)}</strong>
        <div className="flex items-center gap-2">
          <span className="faint">{step.executionLatencyMs ? `${step.executionLatencyMs} ms` : ""}</span>
          <div className="assistant-hover-actions" role="toolbar" aria-label="Response actions">
            <button
              type="button"
              className={`assistant-action-btn ${copied ? "copied" : ""}`}
              onClick={handleCopy}
              title="Copy bot response"
              aria-label="Copy response"
            >
              {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
            {onReply ? (
              <button
                type="button"
                className="assistant-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply(step.contentMarkdown, step.modelUsed);
                }}
                title="Reply to this response"
                aria-label="Reply response"
              >
                <Reply size={11} />
                <span>Reply</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <MarkdownResponse content={step.contentMarkdown} userRequestedPdf={userRequestedPdf} />
    </article>
  );

});



const MarkdownResponse = memo(function MarkdownResponse({ content, userRequestedPdf }: { content: string; userRequestedPdf?: boolean }) {

  const [exporting, setExporting] = useState(false);

  const [readerOpen, setReaderOpen] = useState(false);

  const [copied, setCopied] = useState(false);



  // Sanitize content: remove raw tool_call artifacts and unknown tokens

  const sanitized = useMemo(() => {

    return content

      .replace(/<\|?tool_call\|?>/gi, "")

      .replace(/<\|?tool_call\|?[^>]*>/gi, "")

      .replace(/<\|[^>]*\|>/g, "")

      .replace(/terminal_command=\{/g, "")

      .replace(/\{\"command\":\"/g, '"')

      .replace(/\\n/g, "\n")

      .replace(/\\"/g, '"')

      .replace(/\s+terminal_command\s*/g, "")

      .trim();

  }, [content]);



  // PDF export is only offered on long-form reports or when explicitly requested

  const isReport = useMemo(() => {

    if (userRequestedPdf) return true;

    if (/\b(export(ed)? as pdf|saved to pdf|download as pdf|full report|detailed analysis|executive summary)\b/i.test(sanitized)) {

      if (sanitized.length > 300) return true;

    }

    // Very long-form response (> 1800 characters)

    if (sanitized.length >= 1800) return true;

    // Substantive structured document with 3+ headings and >= 900 characters

    const headings = (sanitized.match(/^#{1,4}\s+/gm) || []).length;

    if (headings >= 3 && sanitized.length >= 900) return true;

    // Structured document with tables and substantive length

    const hasTable = /\|[^\n]+\|[^\n]+\|/m.test(sanitized);

    if (hasTable && headings >= 2 && sanitized.length >= 800) return true;

    return false;

  }, [sanitized, userRequestedPdf]);



  const showExport = isReport;



  const exportAsPdf = useCallback(async () => {

    setExporting(true);

    try {

      const { jsPDF } = await import("jspdf");

      const doc = new jsPDF({ unit: "mm", format: "a4" });

      const pageWidth = doc.internal.pageSize.getWidth();

      const pageHeight = doc.internal.pageSize.getHeight();

      const margin = 16;

      const maxWidth = pageWidth - margin * 2;



      doc.setFontSize(14);

      doc.setFont("helvetica", "bold");

      doc.text("Omni Workspace OS — Exported Response", margin, margin);

      doc.setFontSize(9);

      doc.setFont("helvetica", "normal");

      doc.setTextColor(110, 110, 110);

      doc.text(`Generated: ${new Date().toLocaleString()}`, margin, margin + 6);

      doc.setDrawColor(210, 210, 210);

      doc.line(margin, margin + 9, pageWidth - margin, margin + 9);



      doc.setFontSize(10.5);

      doc.setTextColor(30, 30, 30);



      const lines = doc.splitTextToSize(sanitized, maxWidth);

      let y = margin + 16;

      const lineHeight = 5.2;



      for (const line of lines) {

        if (y > pageHeight - margin) {

          doc.addPage();

          y = margin;

        }

        doc.text(line, margin, y);

        y += lineHeight;

      }



      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");

      const filename = `bot-response-${timestamp}.pdf`;

      const dataUri = doc.output("datauristring");



      const saved = await saveExportedFile(filename, dataUri, true);

      useRonic.getState().setToast(saved ? `PDF saved to Downloads: ${filename}` : `PDF exported: ${filename}`);

    } catch (error) {

      console.error("PDF export failed:", error);

      useRonic.getState().setToast("PDF export failed");

    } finally {

      setExporting(false);

    }

  }, [sanitized]);



  const exportAsDoc = useCallback(async () => {

    setExporting(true);

    try {

      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");

      const filename = `bot-response-${timestamp}.doc`;

      const html = `<!DOCTYPE html>

<html>

<head>

<meta charset="utf-8">

<title>Omni Workspace OS - Bot Response</title>

<style>

body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 820px; margin: 40px auto; padding: 24px; color: #1e293b; }

h1, h2, h3 { color: #0f172a; margin-top: 24px; }

code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: 'Cascadia Mono', Consolas, monospace; font-size: 13px; }

pre { background: #f1f5f9; padding: 14px; border-radius: 8px; overflow-x: auto; border: 1px solid #e2e8f0; }

table { border-collapse: collapse; width: 100%; margin: 18px 0; }

th, td { border: 1px solid #cbd5e1; padding: 9px 13px; text-align: left; }

th { background: #f8fafc; font-weight: 600; }

ul, ol { padding-left: 26px; }

li { margin: 5px 0; }

</style>

</head>

<body>

<div id="content">${sanitized.replace(/\n/g, "<br>")}</div>

</body>

</html>`;

      const base64 = btoa(unescape(encodeURIComponent(html)));

      const dataUri = `data:application/msword;base64,${base64}`;



      const saved = await saveExportedFile(filename, dataUri, false);

      useRonic.getState().setToast(saved ? `DOC saved to Downloads: ${filename}` : `DOC exported: ${filename}`);

    } catch (error) {

      console.error("DOC export failed:", error);

      useRonic.getState().setToast("DOC export failed");

    } finally {

      setExporting(false);

    }

  }, [sanitized]);



  return (

    <div className="markdown-response">

      <div className="markdown-content">

        <ReactMarkdown remarkPlugins={[remarkGfm]}>

          {sanitized}

        </ReactMarkdown>

      </div>



      {showExport && (

        <div className="response-export">

          <button

            type="button"

            className="response-export-btn read-btn"

            onClick={() => setReaderOpen(true)}

            title="Read formatted document preview"

          >

            <Eye size={13} />

            Read

          </button>

          <button

            type="button"

            className="response-export-btn"

            onClick={exportAsPdf}

            disabled={exporting}

            title="Save PDF directly to your Downloads folder"

          >

            <Download size={13} />

            {exporting ? "Saving..." : "PDF"}

          </button>

          <button

            type="button"

            className="response-export-btn"

            onClick={exportAsDoc}

            disabled={exporting}

            title="Save formatted Word document (.doc) to Downloads"

          >

            <FileText size={13} />

            {exporting ? "Saving..." : "DOC"}

          </button>

        </div>

      )}



      {readerOpen && (

        <div className="pdf-reader-modal-overlay" onClick={() => setReaderOpen(false)}>

          <div className="pdf-reader-modal" onClick={(e) => e.stopPropagation()}>

            <div className="pdf-reader-header">

              <div className="pdf-reader-title">

                <FileText size={17} style={{ color: "var(--accent)" }} />

                <span>Document Reader & Preview</span>

              </div>

              <div className="pdf-reader-actions">

                <button

                  type="button"

                  className="response-export-btn"

                  onClick={async () => {

                    await navigator.clipboard.writeText(sanitized);

                    setCopied(true);

                    setTimeout(() => setCopied(false), 2000);

                  }}

                  title="Copy markdown content to clipboard"

                >

                  {copied ? <Check size={13} style={{ color: "#10b981" }} /> : <FileText size={13} />}

                  {copied ? "Copied" : "Copy"}

                </button>

                <button

                  type="button"

                  className="response-export-btn read-btn"

                  onClick={exportAsPdf}

                  disabled={exporting}

                  title="Save PDF to Downloads folder"

                >

                  <Download size={13} />

                  {exporting ? "Saving..." : "Download PDF"}

                </button>

                <button

                  type="button"

                  className="icon-btn"

                  onClick={() => setReaderOpen(false)}

                  title="Close document reader"

                  aria-label="Close"

                  style={{ marginLeft: 6, padding: "4px 8px" }}

                >

                  <X size={16} />

                </button>

              </div>

            </div>

            <div className="pdf-reader-body">

              <div className="pdf-reader-sheet">

                <ReactMarkdown remarkPlugins={[remarkGfm]}>

                  {sanitized}

                </ReactMarkdown>

              </div>

            </div>

          </div>

        </div>

      )}

    </div>

  );

});



const ToolBody = memo(function ToolBody({ step }: { step: Step }) {

  if (step.actionType === "code_diff") return <Diff stepId={step.id} payload={step.actionPayload} />;

  if (step.actionType === "pty_terminal") {

    return <pre className="pre">{`$ ${String(step.actionPayload.command ?? "")}\n${String(step.actionPayload.output ?? "")}`}</pre>;

  }

  if (step.actionType === "cdp_browser" || step.actionType === "browser_inspect") {

    return (

      <div className="stack">

        <span className="mono">{String(step.actionPayload.url ?? "")}</span>

        {Array.isArray(step.actionPayload.log) ? <pre className="pre">{(step.actionPayload.log as unknown[]).map(String).join("\n")}</pre> : null}

      </div>

    );

  }

  if (step.actionType === "wallet_tx") {

    return <Pill kind={tone(String(step.actionPayload.note ?? step.contentMarkdown))}>{String(step.actionPayload.note ?? step.contentMarkdown)}</Pill>;

  }

  return null;

});



const Diff = memo(function Diff({ stepId, payload }: { stepId: string; payload: Record<string, unknown> }) {

  const run = useRonic((s) => s.run);

  const status = String(payload.status ?? "pending");

  return (

    <div className="stack">

      <div className="between">

        <span className="mono">{String(payload.file ?? "diff")} · +{String(payload.added ?? 0)} / -{String(payload.removed ?? 0)}</span>

        <Pill kind={tone(status)}>{status}</Pill>

      </div>

      <div className="diff pre">

        {hunksOf(payload).map((hunk, index) =>

          hunk.kind === "del" ? <del key={index}>{`- ${hunk.text}`}</del> : <ins key={index}>{`+ ${hunk.text}`}</ins>,

        )}

      </div>

      {payload.note ? <p className="faint">{String(payload.note)}</p> : null}

      <div className="row-actions">

        <button className="btn small" onClick={() => void run("set_diff_status", { stepId, status: "accepted" })}>Accept</button>

        <button className="btn ghost small" onClick={() => void run("set_diff_status", { stepId, status: "rejected" })}>Reject</button>

      </div>

    </div>

  );

});



export function Profiles() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);

  const active = snap.profiles.find((item) => item.id === snap.activeProfileId) ?? snap.profiles[0];
  const [draft, setDraft] = useState<BotProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  const profile = draft && draft.id === active?.id ? draft : active;

  function edit(next: BotProfile) {
    setDraft(next);
  }

  const filteredProfiles = snap.profiles.filter((p) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return p.handle.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q) || (p.role || "").toLowerCase().includes(q);
  });

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        {/* Top Header */}
        <header className="p-4 sm:p-6 border-b border-slate-100 flex items-center justify-between gap-4 flex-wrap bg-white/95 backdrop-blur-xs sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => go("chat")}
              className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-3 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
            >
              <ChevronLeft size={16} /> Back to Chat
            </button>
            <div className="h-5 w-px bg-slate-200" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Bot Personas & Soul Profiles</h1>
                <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200/70">
                  {snap.profiles.length} bot{snap.profiles.length === 1 ? "" : "s"}
                </span>
                {profile && (
                  <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Active: {profile.handle}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Configure identity, system soul instructions, multi-provider reasoning lanes, and desktop tool permissions.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5 shadow-xs"
            >
              <Plus size={14} /> New Bot
            </button>

            {profile && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("duplicate_profile", { profileId: profile.id })}
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer shadow-xs disabled:opacity-40"
              >
                Duplicate
              </button>
            )}

            {profile && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("save_profile", { profile })}
                className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-white text-xs font-semibold px-4 py-2 rounded-full transition-all duration-150 cursor-pointer shadow-xs active:scale-95 border border-zinc-700/50 flex items-center gap-1.5 disabled:opacity-40"
              >
                <Check size={14} /> Save Profile
              </button>
            )}
          </div>
        </header>

        {/* Content Body */}
        {!profile ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
              <Sparkles size={28} />
            </div>
            <h2 className="text-base font-bold text-slate-800">No bot profiles found</h2>
            <p className="text-xs text-slate-500 max-w-sm mt-1 mb-4">
              A bot is a local agent profile: an avatar, identity handle, system SOUL prompt, and reasoning lanes.
            </p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold px-4 py-2 rounded-full transition-all cursor-pointer border border-zinc-700/50 shadow-xs"
            >
              Create First Bot
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {/* Left Rail: Bot Roster */}
            <aside className="w-full lg:w-72 border-b lg:border-b-0 lg:border-r border-slate-100 flex flex-col bg-slate-50/50 shrink-0">
              <div className="p-3 border-b border-slate-100">
                <input
                  type="text"
                  placeholder="Filter bots..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                />
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {filteredProfiles.map((item) => {
                  const isSelected = item.id === profile.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setDraft(null);
                        void run("switch_profile", { profileId: item.id });
                      }}
                      className={`w-full text-left p-2.5 rounded-2xl transition-all cursor-pointer flex items-center justify-between gap-3 ${
                        isSelected
                          ? "bg-white shadow-xs border border-slate-200/90 ring-1 ring-slate-900/5"
                          : "hover:bg-slate-100/70 border border-transparent text-slate-600"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <strong className="text-xs font-bold text-slate-900 truncate">{item.handle}</strong>
                          {item.id === snap.activeProfileId && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Active bot" />
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 truncate mt-0.5">{item.displayName || "Unnamed bot"}</p>
                        {item.role && <p className="text-[10px] text-slate-400 truncate mt-0.5">{item.role}</p>}
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0 border border-slate-200/60">
                        ${item.dailyWalletLimitUsd || 0}/d
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* Right Workspace: Bot Configuration */}
            <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5 bg-white">
              {/* Identity & Basic Info */}
              <section className="bg-slate-50/60 border border-slate-200/70 rounded-2xl p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Identity & Handle</h3>
                  <span className="text-[11px] font-mono text-slate-400">ID: {profile.id}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">Bot Handle</span>
                    <input
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                      value={profile.handle}
                      onChange={(event) => edit({ ...profile, handle: event.target.value })}
                      placeholder="@botname"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">Display Name</span>
                    <input
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                      value={profile.displayName}
                      onChange={(event) => edit({ ...profile, displayName: event.target.value })}
                      placeholder="e.g. Chief Architect"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">Role / Purpose</span>
                    <input
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                      value={profile.role}
                      onChange={(event) => edit({ ...profile, role: event.target.value })}
                      placeholder="e.g. Full-stack coding & code review"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">Daily Wallet Limit (USD)</span>
                    <input
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                      type="number"
                      value={profile.dailyWalletLimitUsd}
                      onChange={(event) => edit({ ...profile, dailyWalletLimitUsd: Number(event.target.value) })}
                      placeholder="10"
                    />
                  </label>
                </div>
              </section>

              {/* Provider & Model Routing */}
              <section className="bg-slate-50/60 border border-slate-200/70 rounded-2xl p-4 sm:p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Reasoning Accounts & Model Lanes</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <Account
                    label="Primary Provider"
                    value={profile.primaryAccountId}
                    providers={snap.providers}
                    onChange={(primaryAccountId) => edit({ ...profile, primaryAccountId })}
                  />
                  <Account
                    label="Long Context Provider"
                    value={profile.longContextAccountId}
                    providers={snap.providers}
                    onChange={(longContextAccountId) => edit({ ...profile, longContextAccountId })}
                  />
                  <Account
                    label="Fallback Provider"
                    value={profile.fallbackAccountId}
                    providers={snap.providers}
                    onChange={(fallbackAccountId) => edit({ ...profile, fallbackAccountId })}
                  />
                </div>
              </section>

              {/* Permissions & Obsidian Folder */}
              <section className="bg-slate-50/60 border border-slate-200/70 rounded-2xl p-4 sm:p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Autonomous Privileges & Scope</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Toggle
                    label="Computer Use"
                    on={profile.allowComputerUse}
                    onClick={() => edit({ ...profile, allowComputerUse: !profile.allowComputerUse })}
                  />
                  <Toggle
                    label="Browser Automation"
                    on={profile.allowBrowserUse}
                    onClick={() => edit({ ...profile, allowBrowserUse: !profile.allowBrowserUse })}
                  />
                  <Toggle
                    label="Code Execution"
                    on={profile.allowCodeExec}
                    onClick={() => edit({ ...profile, allowCodeExec: !profile.allowCodeExec })}
                  />
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">Scoped Obsidian / Knowledge Folder</span>
                  <input
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all font-mono"
                    value={profile.scopedObsidianFolder}
                    onChange={(event) => edit({ ...profile, scopedObsidianFolder: event.target.value })}
                    placeholder="e.g. Workspace/Agents/Architect"
                  />
                </label>
              </section>

              {/* SOUL.md Directives Editor */}
              <section className="bg-slate-50/60 border border-slate-200/70 rounded-2xl p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">SOUL.md Directives & System Prompt</h3>
                  <span className="text-[11px] font-mono text-slate-400">{(profile.soulMarkdown || "").length} characters</span>
                </div>
                <textarea
                  className="w-full h-56 p-3 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 font-mono outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all leading-relaxed resize-y"
                  value={profile.soulMarkdown}
                  onChange={(event) => edit({ ...profile, soulMarkdown: event.target.value })}
                  placeholder="# System Soul Directive&#10;Write the persona instructions, style constraints, and operational rules for this bot..."
                />
              </section>
            </main>
          </div>
        )}
      </div>

      {creating ? <CreateBot onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function Account({ label, value, providers, onChange }: { label: string; value: string; providers: Provider[]; onChange: (id: string) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      <select
        className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all cursor-pointer"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Default / Unspecified</option>
        {providers.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} ({item.providerType})
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 text-left ${
        on
          ? "bg-white border-emerald-300 shadow-xs ring-1 ring-emerald-500/10"
          : "bg-white border-slate-200 hover:border-slate-300 text-slate-600"
      }`}
      onClick={onClick}
    >
      <span className="text-xs font-semibold text-slate-800">{label}</span>
      <span
        className={`text-[10px] font-bold px-2 py-0.5 rounded-full transition-all ${
          on ? "bg-emerald-100 text-emerald-800 border border-emerald-200" : "bg-slate-100 text-slate-500 border border-slate-200"
        }`}
      >
        {on ? "Enabled" : "Disabled"}
      </span>
    </button>
  );
}

function CreateBot({ onClose }: { onClose: () => void }) {
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("");
  const [soulMarkdown, setSoul] = useState("");

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150" onClick={onClose}>
      <div className="bg-[#f1f3f6] rounded-3xl max-w-lg w-full p-6 space-y-4" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Create New Bot Persona</h2>
            <p className="text-xs text-slate-500">Configure new agent profile with custom handle and soul prompt.</p>
          </div>
          <button
            type="button"
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all cursor-pointer"
            onClick={onClose}
            title="Close modal"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">Bot Handle</span>
            <input
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 transition-all"
              placeholder="@agentname"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">Display Name</span>
            <input
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 transition-all"
              placeholder="e.g. Lead Engineer"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">Role Purpose</span>
            <input
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 transition-all"
              placeholder="e.g. Code architect and bug resolution"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">SOUL.md Directive</span>
            <textarea
              className="w-full h-28 p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl text-slate-800 font-mono outline-none focus:bg-white focus:border-slate-400 transition-all resize-y"
              placeholder="Enter system prompt and instructions for this bot..."
              value={soulMarkdown}
              onChange={(event) => setSoul(event.target.value)}
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-white text-xs font-semibold px-4 py-2 rounded-full transition-all duration-150 cursor-pointer shadow-xs active:scale-95 border border-zinc-700/50 disabled:opacity-40"
            disabled={busy || handle.trim().length === 0 || displayName.trim().length === 0}
            onClick={() => {
              void run("create_profile", { draft: { handle, displayName, role, soulMarkdown } });
              onClose();
            }}
          >
            Create Bot
          </button>
        </div>
      </div>
    </div>
  );
}

type BotPreset = {
  handle: string;
  name: string;
  kind: "subscription" | "api" | "command";
  appId?: string;
  engine?: string;
  apiBase?: string;
  apiModel?: string;
  providerRef?: string;
  keyHint?: string;
  note?: string;
};

// Original bots come first: the service's own product, used with the
// subscription the user already pays for — sign-in where the service
// officially allows in-app replies (ChatGPT plan, Claude Code, Gemini CLI),
// the original site embedded for the rest (grok.com, meta.ai). API presets
// are the honest in-chat option for services without a subscription bridge.
const BOT_PRESETS: BotPreset[] = [
  { handle: "@grokbot", name: "Grok", kind: "subscription", engine: "Grok · grok.com", apiBase: "https://grok.com", providerRef: "prov_grok", note: "The original Grok: Open opens grok.com with your X/Grok subscription login. In-chat replies here also work with an xAI API key if you add one." },
  { handle: "@chatgpt", name: "ChatGPT", kind: "subscription", engine: "ChatGPT · your plan", apiBase: "https://chatgpt.com", providerRef: "prov_chatgpt", note: "Uses your ChatGPT plan through the official Sign in with ChatGPT — no API key. Sign in from Apps & providers, then press Check." },
  { handle: "@claude", name: "Claude", kind: "subscription", engine: "Claude · Claude Code login", apiBase: "https://claude.ai", providerRef: "prov_claude", note: "Uses your Claude subscription through the Claude Code CLI login — no API key. Install and sign in to Claude Code, then press Check." },
  { handle: "@gemini", name: "Gemini", kind: "subscription", engine: "Gemini · Google login", apiBase: "https://gemini.google.com", providerRef: "prov_gemini", note: "Uses your Google account through the Gemini CLI — no API key. Install and sign in to Gemini CLI, then press Check." },
  { handle: "@metaai", name: "Meta AI", kind: "subscription", engine: "Meta AI · meta.ai", apiBase: "https://meta.ai", providerRef: "", note: "Meta AI has no official in-app bridge yet: Open opens meta.ai with your Meta login. For in-chat Meta models, use the @muse preset." },
  { handle: "@muse", name: "Muse", kind: "api", engine: "Muse · Meta Llama via NVIDIA NIM", apiBase: "https://integrate.api.nvidia.com/v1", apiModel: "meta/llama-3.3-70b-instruct", providerRef: "prov_nvidia", keyHint: "NVIDIA API key from build.nvidia.com", note: "In-chat Meta Llama through NVIDIA NIM — Meta's open models, real endpoint, real replies." },
  { handle: "@deepseek", name: "DeepSeek", kind: "api", engine: "DeepSeek", apiBase: "https://api.deepseek.com/v1", apiModel: "deepseek-chat", providerRef: "prov_deepseek", keyHint: "DeepSeek API key", note: "DeepSeek's official API — in-chat replies come from deepseek-chat." },
  { handle: "@llama", name: "Llama", kind: "api", engine: "Llama · OpenRouter", apiBase: "https://openrouter.ai/api/v1", apiModel: "meta-llama/llama-3.3-70b-instruct", providerRef: "prov_openrouter", keyHint: "OpenRouter API key", note: "Open-source Meta Llama through OpenRouter — hundreds of open models behind one key." },
  { handle: "@dots", name: "Dots", kind: "command", appId: "app_dots" },
  { handle: "@hermes", name: "Hermes", kind: "command", appId: "app_hermes" },
  { handle: "@openclaw", name: "OpenClaw", kind: "command", appId: "app_openclaw" },
];

export function BotsHub() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);

  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [engine, setEngine] = useState("");
  const [mode, setMode] = useState("subscription");
  const [commandOrUrl, setCommandOrUrl] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiModel, setApiModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerRef, setProviderRef] = useState("");
  const [linkNote, setLinkNote] = useState("");

  function detectedApp(appId: string) {
    const app = (snap.apps || []).find((item) => item.id === appId);
    const path = app?.executablePath?.trim() || "";
    const ready = path.length > 0 && app?.status !== "missing";
    return { path: ready ? path : "", ready };
  }

  function providerHasKey(id?: string) {
    if (!id) return false;
    return (snap.providers || []).some((item) => item.id === id && item.hasSecret);
  }

  function applyPreset(preset: BotPreset) {
    setHandle(preset.handle);
    setDisplayName(preset.name);
    setMode(preset.kind);
    setApiKey("");
    if (preset.kind === "subscription") {
      setEngine(preset.engine || "");
      setApiBase(preset.apiBase || "");
      setApiModel("");
      setProviderRef(preset.providerRef || "");
      setCommandOrUrl(preset.apiBase || "");
      setLinkNote(preset.note || "");
    } else if (preset.kind === "api") {
      setEngine(preset.engine || "");
      setApiBase(preset.apiBase || "");
      setApiModel(preset.apiModel || "");
      setProviderRef(preset.providerRef || "");
      setCommandOrUrl(preset.apiBase || "");
      const keyed = providerHasKey(preset.providerRef);
      setLinkNote(
        keyed
          ? `${preset.name} will use the key already saved for ${preset.engine}. Press Connect, then Check, and it chats live.`
          : preset.note || `${preset.name} needs a ${preset.keyHint}. Paste it below — it is stored locally and reused by ${preset.engine}.`
      );
    } else {
      setEngine("");
      setApiBase("");
      setApiModel("");
      setProviderRef("");
      const found = detectedApp(preset.appId || "");
      if (found.ready) {
        setEngine("Installed program");
        setCommandOrUrl(found.path);
        setLinkNote(`${preset.name} was found at ${found.path}. Connect and mount saves it, then Start launches that program.`);
      } else {
        setCommandOrUrl("");
        setLinkNote(`${preset.name} is not installed on this computer. Paste a command, a localhost URL, or a GitHub repository.`);
      }
    }
  }

  const bound = mode === "api" || mode === "subscription";
  const connectDisabled =
    busy ||
    handle.trim().length === 0 ||
    (mode === "api" ? apiBase.trim().length === 0 || apiModel.trim().length === 0 : apiBase.trim().length === 0 && commandOrUrl.trim().length === 0);

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        {/* Header */}
        <header className="p-4 sm:p-6 border-b border-slate-100 flex items-center justify-between gap-4 flex-wrap bg-white/95 backdrop-blur-xs sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => go("chat")}
              className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-3 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
            >
              <ChevronLeft size={16} /> Back to Chat
            </button>
            <div className="h-5 w-px bg-slate-200" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">External Bots & Connectors</h1>
                <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200/70">
                  {snap.profiles.length} connected
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Connect original bots via subscriptions (ChatGPT, Claude Code, Gemini, Grok) or OpenAI-compatible live APIs.
              </p>
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* Preset Buttons */}
          <section className="bg-slate-50/60 border border-slate-200/70 rounded-2xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Quick Integration Presets</h3>
              <span className="text-[11px] text-slate-400">Click to autofill parameters</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {BOT_PRESETS.map((preset) => {
                const ready =
                  preset.kind === "api"
                    ? providerHasKey(preset.providerRef)
                    : preset.kind === "command"
                    ? detectedApp(preset.appId || "").ready
                    : true;
                return (
                  <button
                    key={preset.handle}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="text-xs font-medium px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 transition-all cursor-pointer flex items-center gap-1.5 shadow-xs"
                    title={preset.engine || preset.handle}
                  >
                    <span>{preset.handle}</span>
                    <span className="text-[10px] text-slate-400">({preset.kind})</span>
                    {preset.kind === "command" && !ready && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-200">uninstalled</span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Connection Form */}
          <section className="bg-white border border-slate-200/80 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Bot Connection Parameters</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">Handle</span>
                <input
                  className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                  placeholder="@grokbot"
                  value={handle}
                  onChange={(event) => setHandle(event.target.value)}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">Display Name</span>
                <input
                  className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                  placeholder="Grok"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">Link Mode</span>
                <select
                  className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all cursor-pointer"
                  value={mode}
                  onChange={(event) => setMode(event.target.value)}
                >
                  <option value="subscription">Original bot — your subscription</option>
                  <option value="api">Cloud bot — live API (OpenAI-compatible)</option>
                  <option value="command">Local directory or command</option>
                  <option value="http">WebSocket or HTTP webhook</option>
                  <option value="github">GitHub clone</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">{bound ? "Engine Label" : "Engine"}</span>
                <input
                  className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all"
                  placeholder={mode === "subscription" ? "Grok · grok.com" : mode === "api" ? "Grok · xAI" : "Python uv, Rust, Bun"}
                  value={engine}
                  onChange={(event) => setEngine(event.target.value)}
                />
              </label>
            </div>

            {mode === "api" ? (
              <div className="space-y-3 pt-2 border-t border-slate-100">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">API Base URL</span>
                    <input
                      className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all font-mono"
                      placeholder="https://api.x.ai/v1"
                      value={apiBase}
                      onChange={(event) => setApiBase(event.target.value)}
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">Model ID</span>
                    <input
                      className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all font-mono"
                      placeholder="grok-4"
                      value={apiModel}
                      onChange={(event) => setApiModel(event.target.value)}
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">API Key (optional if already stored)</span>
                  <input
                    className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all font-mono"
                    type="password"
                    placeholder="xai-…"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="off"
                  />
                </label>
              </div>
            ) : mode === "subscription" ? (
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">Original Site URL</span>
                  <input
                    className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all font-mono"
                    placeholder="https://grok.com"
                    value={apiBase}
                    onChange={(event) => setApiBase(event.target.value)}
                  />
                </label>
                <p className="text-[11px] text-slate-500">
                  The bot card gets an Open button for the original site with your subscription login. In-chat replies use your signed-in plan where officially supported.
                </p>
              </div>
            ) : (
              <div className="pt-2 border-t border-slate-100">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">
                    {mode === "github" ? "GitHub Repository URL" : mode === "http" ? "Webhook / WebSocket Endpoint" : "Execution Command or Directory"}
                  </span>
                  <input
                    className="w-full px-3 py-2 text-xs bg-slate-50/60 border border-slate-200 rounded-xl text-slate-800 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all font-mono"
                    value={commandOrUrl}
                    onChange={(event) => setCommandOrUrl(event.target.value)}
                    placeholder={mode === "command" ? "Path to a program or command such as uv run python main.py" : ""}
                  />
                </label>
              </div>
            )}

            {linkNote && (
              <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl text-amber-800 text-xs">
                {linkNote}
              </div>
            )}

            <div className="pt-2">
              <button
                type="button"
                className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-white text-xs font-semibold px-5 py-2.5 rounded-full transition-all duration-150 cursor-pointer shadow-xs active:scale-95 border border-zinc-700/50 disabled:opacity-40"
                disabled={connectDisabled}
                onClick={() =>
                  void run("connect_external_bot", {
                    draft: { handle, displayName, engine, mode, commandOrUrl, apiBase, apiModel, apiKey, providerRef },
                  })
                }
              >
                {mode === "subscription" ? "Connect Original Bot" : mode === "api" ? "Connect Live API Bot" : "Connect & Mount"}
              </button>
            </div>
          </section>

          {/* Active Bot Cards */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Configured External Bots</h3>
            {snap.profiles.length === 0 ? (
              <p className="text-xs text-slate-400 p-4 border border-dashed border-slate-200 rounded-2xl text-center">
                No external bots connected yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {snap.profiles.map((bot) => {
                  const cloud = bot.engineKind === "openai_api";
                  const original = bot.engineKind === "subscription";
                  const live = bot.runStatus === "running";
                  const needsKey = cloud && /needs an api key/i.test(bot.statusLine || "");

                  return (
                    <article
                      key={bot.id}
                      className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:border-slate-300 transition-all flex flex-col justify-between space-y-3"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-xs font-bold text-slate-900">{bot.handle}</strong>
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                              live
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : bot.runStatus === "ready" && !needsKey
                                ? "bg-slate-100 text-slate-600 border-slate-200"
                                : "bg-amber-50 text-amber-700 border-amber-200"
                            }`}
                          >
                            {live ? "● Live" : bot.runStatus === "ready" ? (needsKey ? "○ Needs Key" : "○ Ready") : "○ Stopped"}
                          </span>
                        </div>
                        <p className="text-xs font-medium text-slate-700">{bot.displayName}</p>
                        <p className="text-[11px] text-slate-500">{bot.engine || "No engine saved"}</p>
                        <p className="text-[10px] font-mono text-slate-400 truncate bg-slate-50 px-2 py-1 rounded-lg border border-slate-100">
                          {bot.apiBase || bot.commandOrUrl || "Local default"}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 pt-2 border-t border-slate-100 flex-wrap">
                        <button
                          type="button"
                          className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer disabled:opacity-40"
                          disabled={busy || (!cloud && !original && !bot.commandOrUrl)}
                          onClick={() => void run("set_bot_run", { id: bot.id, action: "start" })}
                        >
                          {cloud || original ? "Check" : "Start"}
                        </button>

                        {original ? (
                          <button
                            type="button"
                            className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer disabled:opacity-40"
                            disabled={busy || !(bot.apiBase || bot.commandOrUrl)}
                            onClick={() =>
                              void run("open_provider_window", {
                                label: bot.primaryAccountId,
                                url: bot.apiBase || bot.commandOrUrl,
                              })
                            }
                          >
                            Open Original
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer disabled:opacity-40"
                            disabled={busy || cloud}
                            onClick={() => void run("set_bot_run", { id: bot.id, action: "stop" })}
                          >
                            Stop
                          </button>
                        )}

                        <button
                          type="button"
                          className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer ml-auto"
                          onClick={() => {
                            void run("switch_profile", { profileId: bot.id });
                            go("chat");
                          }}
                        >
                          Open in Chat
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

