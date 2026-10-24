import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, Brain, ChevronDown, ChevronUp, Globe, Minimize2, Minus, Plus, RefreshCw, Square, Terminal as TerminalIcon, X } from "lucide-react";
import { isTauri, pickPaths } from "../api";
import { clipName, customAsWebApp, newCustomId, readCustomApps, readHiddenApps, validWebUrl, writeCustomApps, writeHiddenApps, type CustomApp } from "../kernel/customApps";
import { chatProviderLinks, DOWNLOADS, hasStoredSecret, WEB_APPS, type ChatModel, type WebApp } from "../kernel/liveChat";
import { addCustom, catalog, effortFor, hideModel, loadConnectedModels, saveEdit, setEffort, starIds, toggleStar } from "../kernel/modelPrefs";
import { inIndex, proposedDiff } from "../kernel/skillIndex";
import { bridgeStatus, hideWorkspaceWebapps, listInstalledWebapps, openHarnessWindow, placeWorkspaceWebapp, showWorkspaceWebapp, type WebAppBounds } from "../lib/tauriBridge";
import type { BotProfile, Provider, Step } from "../types";
import { useOmni } from "../store";
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

const DOCK_KEY = "omni.dock";
const MODEL_KEY = "omni.selectedModel.v1";
type DockTab = "apps" | "accounts" | "capabilities";
type AppsSide = "web" | "desktop";
type DockState = { open: boolean; width: number; tab: DockTab; apps: AppsSide };
const WEBAPP_KEY = "omni.webapps";
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
      step.actionType !== "harness2_pipeline" &&
      (step.actionType === "thinking" ||
      step.role === "tool" ||
      step.actionType === "handoff_capsule" ||
      step.actionType === "bot_handoff");
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

export function Chat() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);
  const pending = useOmni((s) => s.pending);
  const generation = useOmni((s) => s.generation);
  const recover = useOmni((s) => s.recover);
  const recovering = useOmni((s) => s.recovering);
  const terminal = useOmni((s) => s.terminal);
  const setTerminal = useOmni((s) => s.setTerminal);
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
  const [plusOpen, setPlusOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [profileBotId, setProfileBotId] = useState("");
  const [dock, setDock] = useState(readDock);
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
  const [liveActivity, setLiveActivity] = useState<string | null>(null);
  const [lastSentPrompt, setLastSentPrompt] = useState<string>("");
  const [lastSentFiles, setLastSentFiles] = useState<string[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>(readTabs);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobsNudge, setJobsNudge] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const threadBox = useRef<HTMLElement | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const isScrolledUpRef = useRef(false);



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
  const steps = useMemo(() => snap.steps.filter((item) => item.threadId === snap.activeThreadId), [snap.steps, snap.activeThreadId]);
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
    (busy && optimisticSteps.length > 0)
  );

  const displayActivity = useMemo(() => {
    if (deskBusy !== null) {
      return deskMode === "install" ? "installing app..." : "opening app...";
    }
    if (pending === "run_routine") return "running routine...";
    if (pending === "resolve_gateway") return "verifying security gateway...";
    if (liveActivity) return liveActivity;
    return "thinking...";
  }, [deskBusy, deskMode, pending, liveActivity]);

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
    setLiveActivity(null);
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
    setLiveActivity(null);
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
    setLiveActivity(null);
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
    const prefill = sessionStorage.getItem("omni.prefillPrompt");
    if (prefill) {
      sessionStorage.removeItem("omni.prefillPrompt");
      setPrompt(prefill);
    }
    const focus = sessionStorage.getItem("omni.focusHarness");
    if (focus) sessionStorage.removeItem("omni.focusHarness");
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
        setDeskNote(useOmni.getState().toast ?? `Could not open ${app.name}.`);
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

  async function send(customText?: string, customFiles?: string[]) {
    let text = (typeof customText === "string" ? customText : prompt).trim();
    if (/\b(scan|look at|see|read)\b/i.test(text) && /\b(screen|app|page|chat|pane|other|webapp|desktop)\b/i.test(text)) {
      text = `${text}\n\nVisible chat:\n${chatSnapshot()}\n\nVisible app:\n${appSnapshot()}`;
    }
    const attachments = customFiles ?? files;
    if (sending.current || busy || (!text && attachments.length === 0) || !model) return;
    const ticket = useOmni.getState().generation;
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

    // 2. Identify active background activity from user intent
    const lower = text.toLowerCase();
    const activity = /install|download|npm|pip|cargo|plugin|package|setup/i.test(lower)
      ? "installing..."
      : /search|find|research|lookup|browse|crawl|google|read|scan/i.test(lower)
        ? "researching..."
        : "working...";
    setLiveActivity(activity);
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

    try {
      const res = await run("send_message", {
        prompt: text,
        providerId: model.providerId,
        model: model.upstreamModel,
        modelId: model.id,
        effort: effortFor(model.id),
        attachments,
      });
      if (!res) {
        const storeToast = useOmni.getState().toast;
        if (storeToast && /fail|error|denied|refused|stopped|unable|no connected model|not found|not ready/i.test(storeToast)) {
          setChatError(storeToast);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setChatError(msg || "Error executing request");
    } finally {
      sending.current = false;
      if (useOmni.getState().generation === ticket) {
        setLiveActivity(null);
      }
    }
  }

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
              <span>{activeGroup ? (activeGroup.purpose || modeLabel(activeGroup.coordinationMode)) : (accessBot?.statusLine || accessBot?.role || "Ready for tasks")}</span>
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
              title={accessBot?.takeover ? "Open their screen. They are waiting for you." : "Their screen"}
              onClick={() => setScreenMode((mode) => mode === "closed" ? (accessBot?.takeover ? "takeover" : "preview") : "closed")}
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
            {!thread ? <p className="muted empty-hello">{accessBot ? `Message ${botName(accessBot)} the way you would a teammate. “You are my …” sets the job. “Rename to …” changes the name.` : "Add a bot, then send them the work."}</p> : null}
            {groupedTurns.map((turn) => {
              const chunks = chunkTurnSteps(turn.steps);
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
                      <StepView key={step.id} step={step} />
                    );
                  })}
                </div>
              );
            })}
            {thread && allSteps.length === 0 && !isWorking ? <p className="muted">This task has no steps yet.</p> : null}

            {/* Active Live Background Activity Motion Pill */}
            {isWorking && (
              <div className="chat-live-status-row">
                <div className="chat-live-status-pill">
                  <span className="live-status-pulse" />
                  <span className="live-status-spin" />
                  <span className="live-status-text">{displayActivity}</span>
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
                {files.map((file) => (
                  <span key={file} className="chip">
                    {file.split(/[\\/]/).pop()}
                    <button type="button" onClick={() => setFiles((prev) => prev.filter((item) => item !== file))}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            {files.length > 0 && !isTauri() ? <p className="muted attach-note">This preview cannot read files on disk. Open the desktop app to include their contents.</p> : null}
            <div className="grok-box">
              <textarea
                className="area"
                placeholder={model ? `Message ${talkTo}` : sessionHint}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
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
                  <button type="button" className="model-trigger" data-model-trigger aria-haspopup="listbox" aria-expanded={menuOpen} onClick={() => { setPlusOpen(false); setMenuMode("list"); setMenuOpen((open) => !open); }}>
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
                  <button className="send-round" aria-label="Send" disabled={busy || !model || (prompt.trim().length === 0 && files.length === 0)}>↑</button>
                </div>
              </div>
              {plusOpen ? (
                <div className="plus-menu">
                  <button type="button" onClick={() => { if (!isTauri()) { fileRef.current?.click(); setPlusOpen(false); return; } void pickPaths("files").then((paths) => { if (paths.length) setFiles((prev) => [...prev, ...paths.filter((path) => !prev.includes(path))]); }); setPlusOpen(false); }}>Attach</button>
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
            {selectedProvider?.healthDetail ? <pre className="pre ping-out">{selectedProvider.healthDetail}</pre> : null}
            <p className="muted">Daily wallet limit {profile?.dailyWalletLimitUsd ?? 0} USD · spent today {snap.spentTodayUsd.toFixed(2)} USD</p>
            <p className="muted">{bridgeNote || "In the desktop app, these web apps and Claude Code, Gemini CLI, and Cursor can use this workspace's skills, plugins, and memory."}</p>
            </>
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
    window.addEventListener("omni-signin", onSignIn);
    return () => window.removeEventListener("omni-signin", onSignIn);
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
        useOmni.setState({ toast: res.note });
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

  const toolSteps = steps.filter((s) => s.role === "tool");
  const thinkingSteps = steps.filter((s) => s.actionType === "thinking");
  const toolNames = Array.from(new Set(toolSteps.map((s) => s.modelUsed || "tool").filter(Boolean)));
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

const StepView = memo(function StepView({ step }: { step: Step }) {
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
    return (
      <article className="step user turn-user">
        <p className="step-copy">{step.contentMarkdown}</p>
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
        <summary>{step.modelUsed || "Tool"}</summary>
        <p className="step-copy">{step.contentMarkdown}</p>
        {Object.keys(step.actionPayload).length > 0 ? <pre className="pre">{JSON.stringify(step.actionPayload, null, 2)}</pre> : null}
      </details>
    );
  }
  return (
    <article className="step">
      <div className="between">
        <strong>{step.modelUsed || "Assistant"}</strong>
        <span className="faint">{step.executionLatencyMs ? `${step.executionLatencyMs} ms` : ""}</span>
      </div>
      <p className="step-copy">{step.contentMarkdown}</p>
    </article>
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
  const run = useOmni((s) => s.run);
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
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const active = snap.profiles.find((item) => item.id === snap.activeProfileId) ?? snap.profiles[0];
  const [draft, setDraft] = useState<BotProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const profile = draft && draft.id === active?.id ? draft : active;
  if (!profile) {
    return (
      <div className="screen">
        <div className="between">
          <h1 className="title">Bot profiles</h1>
          <button className="btn" onClick={() => setCreating(true)}>New bot</button>
        </div>
        <p className="muted">No bots yet. A bot is a local profile: a name, a soul file, and which lanes it may use.</p>
        {creating ? <CreateBot onClose={() => setCreating(false)} /> : null}
      </div>
    );
  }

  function edit(next: BotProfile) {
    setDraft(next);
  }

  return (
    <div className="screen">
      <div className="between">
        <h1 className="title">Bot profiles</h1>
        <div className="row-actions">
          <button className="btn ghost" onClick={() => setCreating(true)}>New bot</button>
          <button className="btn ghost" disabled={busy} onClick={() => void run("duplicate_profile", { profileId: profile.id })}>Duplicate</button>
          <button className="btn" disabled={busy} onClick={() => void run("save_profile", { profile })}>Save</button>
        </div>
      </div>
      <div className="split" style={{ gridTemplateColumns: "240px 1fr" }}>
        <section className="pane">
          <div className="pane-b" style={{ padding: 0 }}>
            {snap.profiles.map((item) => (
              <button key={item.id} className={`list-btn ${item.id === profile.id ? "active" : ""}`} onClick={() => { setDraft(null); void run("switch_profile", { profileId: item.id }); }}>
                <strong>{item.handle}</strong>
                <span className="muted">{item.displayName}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="pane">
          <div className="pane-b stack">
            <div className="grid-2">
              <label className="field"><span>Handle</span><input className="input" value={profile.handle} onChange={(event) => edit({ ...profile, handle: event.target.value })} /></label>
              <label className="field"><span>Display name</span><input className="input" value={profile.displayName} onChange={(event) => edit({ ...profile, displayName: event.target.value })} /></label>
              <label className="field"><span>Role</span><input className="input" value={profile.role} onChange={(event) => edit({ ...profile, role: event.target.value })} /></label>
              <label className="field"><span>Daily wallet limit USD</span><input className="input" type="number" value={profile.dailyWalletLimitUsd} onChange={(event) => edit({ ...profile, dailyWalletLimitUsd: Number(event.target.value) })} /></label>
            </div>
            <div className="grid-3">
              <Account label="Primary" value={profile.primaryAccountId} providers={snap.providers} onChange={(primaryAccountId) => edit({ ...profile, primaryAccountId })} />
              <Account label="Long context" value={profile.longContextAccountId} providers={snap.providers} onChange={(longContextAccountId) => edit({ ...profile, longContextAccountId })} />
              <Account label="Fallback" value={profile.fallbackAccountId} providers={snap.providers} onChange={(fallbackAccountId) => edit({ ...profile, fallbackAccountId })} />
            </div>
            <label className="field"><span>Obsidian folder</span><input className="input" value={profile.scopedObsidianFolder} onChange={(event) => edit({ ...profile, scopedObsidianFolder: event.target.value })} /></label>
            <div className="grid-3">
              <Toggle label="Computer use" on={profile.allowComputerUse} onClick={() => edit({ ...profile, allowComputerUse: !profile.allowComputerUse })} />
              <Toggle label="Browser use" on={profile.allowBrowserUse} onClick={() => edit({ ...profile, allowBrowserUse: !profile.allowBrowserUse })} />
              <Toggle label="Code exec" on={profile.allowCodeExec} onClick={() => edit({ ...profile, allowCodeExec: !profile.allowCodeExec })} />
            </div>
            <label className="field">
              <span>SOUL.md</span>
              <textarea className="area" value={profile.soulMarkdown} onChange={(event) => edit({ ...profile, soulMarkdown: event.target.value })} />
            </label>
          </div>
        </section>
      </div>
      {creating ? <CreateBot onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function Account({ label, value, providers, onChange }: { label: string; value: string; providers: Provider[]; onChange: (id: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="toggle" onClick={onClick}>
      <span>{label}</span>
      <Pill kind={on ? "ok" : ""}>{on ? "on" : "off"}</Pill>
    </button>
  );
}

function CreateBot({ onClose }: { onClose: () => void }) {
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("");
  const [soulMarkdown, setSoul] = useState("");
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="pane-h between" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>New bot</span>
          <button type="button" className="btn ghost small" onClick={onClose} title="Close modal" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="pane-b stack">
          <label className="field"><span>Handle</span><input className="input" placeholder="@name" value={handle} onChange={(event) => setHandle(event.target.value)} /></label>
          <label className="field"><span>Name</span><input className="input" placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className="field"><span>Role</span><input className="input" placeholder="What this bot is for" value={role} onChange={(event) => setRole(event.target.value)} /></label>
          <label className="field"><span>Soul</span><textarea className="area" placeholder="Instructions for this bot" value={soulMarkdown} onChange={(event) => setSoul(event.target.value)} /></label>
          <button className="btn" disabled={busy || handle.trim().length === 0 || displayName.trim().length === 0} onClick={() => { void run("create_profile", { draft: { handle, displayName, role, soulMarkdown } }); onClose(); }}>Create</button>
        </div>
      </div>
    </div>
  );
}

const BOT_PRESETS = [
  { handle: "@grokbot", name: "Grokbot", appId: "app_grokbot" },
  { handle: "@dots", name: "Dots", appId: "app_dots" },
  { handle: "@muse", name: "Muse", appId: "app_muse" },
  { handle: "@hermes", name: "Hermes", appId: "app_hermes" },
  { handle: "@openclaw", name: "OpenClaw", appId: "app_openclaw" },
];

export function BotsHub() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [engine, setEngine] = useState("");
  const [mode, setMode] = useState("command");
  const [commandOrUrl, setCommandOrUrl] = useState("");
  const [linkNote, setLinkNote] = useState("");

  function detectedApp(appId: string) {
    const app = (snap.apps || []).find((item) => item.id === appId);
    const path = app?.executablePath?.trim() || "";
    const ready = path.length > 0 && app?.status !== "missing";
    return { path: ready ? path : "", ready };
  }

  function applyPreset(preset: (typeof BOT_PRESETS)[number]) {
    const found = detectedApp(preset.appId);
    setHandle(preset.handle);
    setDisplayName(preset.name);
    setMode("command");
    if (found.ready) {
      setEngine("Installed program");
      setCommandOrUrl(found.path);
      setLinkNote(`${preset.name} was found at ${found.path}. Connect and mount saves it, then Start launches that program.`);
    } else {
      setEngine("");
      setCommandOrUrl("");
      setLinkNote(`${preset.name} is not installed on this computer. Paste a command, a localhost URL, or a GitHub repository.`);
    }
  }

  return (
    <div className="screen">
      <div className="between">
        <div>
          <h1 className="title">External bots</h1>
          <p className="muted">Link a program that is installed on this computer, a localhost webhook, or a GitHub repository. The preset buttons fill a path only when that program was found.</p>
        </div>
        <button className="btn ghost" onClick={() => go("chat")}>Back to chat</button>
      </div>
      <section className="card stack">
        <div className="row-actions">
          {BOT_PRESETS.map((preset) => {
            const found = detectedApp(preset.appId);
            return (
              <button key={preset.handle} className="btn ghost small" type="button" onClick={() => applyPreset(preset)} title={found.ready ? found.path : `${preset.name} is not installed`}>
                {preset.handle}{found.ready ? "" : " · not installed"}
              </button>
            );
          })}
        </div>
        <div className="grid-2">
          <label className="field"><span>Handle</span><input className="input" placeholder="@grokbot" value={handle} onChange={(event) => setHandle(event.target.value)} /></label>
          <label className="field"><span>Display name</span><input className="input" placeholder="Grokbot" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className="field">
            <span>Link mode</span>
            <select className="select" value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="command">Local directory or command</option>
              <option value="http">WebSocket or HTTP webhook</option>
              <option value="github">GitHub clone</option>
            </select>
          </label>
          <label className="field"><span>Engine</span><input className="input" placeholder="Python uv, Rust, Bun" value={engine} onChange={(event) => setEngine(event.target.value)} /></label>
        </div>
        <label className="field">
          <span>{mode === "github" ? "https://github.com/owner/repo" : mode === "http" ? "http://127.0.0.1:8080/chat or ws://127.0.0.1:9000" : "Command or folder"}</span>
          <input className="input" value={commandOrUrl} onChange={(event) => setCommandOrUrl(event.target.value)} placeholder={mode === "command" ? "Path to a program, or a command such as uv run python main.py" : ""} />
        </label>
        {linkNote ? <p className="muted">{linkNote}</p> : null}
        <div className="row-actions">
          <button
            className="btn"
            disabled={busy || handle.trim().length === 0 || commandOrUrl.trim().length === 0}
            onClick={() => void run("connect_external_bot", { draft: { handle, displayName, engine, mode, commandOrUrl } })}
          >
            Connect and mount
          </button>
        </div>
      </section>
      <div className="grid-2">
        {snap.profiles.map((bot) => (
          <article key={bot.id} className="card stack">
            <div className="between">
              <strong>{bot.handle}</strong>
              <Pill kind={bot.runStatus === "running" || bot.runStatus === "ready" ? "ok" : "warn"}>{bot.runStatus === "running" || bot.runStatus === "ready" ? "● running" : "○ stopped"}</Pill>
            </div>
            <span>{bot.displayName}</span>
            <span className="muted">{bot.engine || "No engine saved"}</span>
            <span className="mono">{bot.commandOrUrl || "No command yet"}</span>
            <div className="row-actions">
              <button className="btn ghost small" disabled={busy || !bot.commandOrUrl} onClick={() => void run("set_bot_run", { id: bot.id, action: "start" })}>Start</button>
              <button className="btn ghost small" disabled={busy} onClick={() => void run("set_bot_run", { id: bot.id, action: "stop" })}>Stop</button>
              <button className="btn small" onClick={() => { void run("switch_profile", { profileId: bot.id }); go("chat"); }}>Open in chat</button>
            </div>
          </article>
        ))}
      </div>
      {snap.profiles.length === 0 ? <p className="muted">No bots linked yet.</p> : null}
    </div>
  );
}
