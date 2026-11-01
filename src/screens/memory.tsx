import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Brain,
  Check,
  CheckCheck,
  Copy,
  Download,
  ExternalLink,
  Folder,
  History,
  Layers,
  Network,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sliders,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useRonic } from "../store";
import { pickPaths } from "../api";
import type { MemoryEngine, MemoryItem } from "../types";
import { Pill, when } from "../ui/bits";

export type MemoryCategory =
  | "architecture"
  | "preference"
  | "workflow"
  | "quant_rule"
  | "domain_fact";

export interface Mem0AtomicMemory {
  id: string;
  title: string;
  fact: string;
  category: MemoryCategory;
  appliesTo: string;
  source: string;
  fileOrUri: string;
  tags: string[];
  metadata?: Record<string, string | number | boolean | undefined>;
  confidence: number;
  pinned: boolean;
  updatedAt: string;
}

export interface Mem0GraphEdge {
  id: string;
  source: string;
  sourceType: "note";
  relation: string;
  target: string;
  targetType: "wikilink";
  memoryId: string;
  appliesTo: string;
}

interface JournalRow {
  id: string;
  op: string;
  memoryId: string;
  title: string;
  source: string;
  createdAt: number;
}

interface SearchHit {
  id: string;
  title: string;
  content: string;
  score: number;
}

const META_STORAGE_KEY = "ronic.mem0.meta_v2";
const DEMO_MEMORY_IDS = new Set(["mem_101", "mem_102", "mem_103", "mem_104"]);

function listFromPayload(payload: unknown, key: string): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function inferCategory(title: string, text: string): MemoryCategory {
  const combined = `${title} ${text}`.toLowerCase();
  if (combined.includes("hyperliquid") || combined.includes("usdc") || combined.includes("slippage") || combined.includes("wallet") || combined.includes("quant") || combined.includes("trade")) {
    return "quant_rule";
  }
  if (combined.includes("tauri") || combined.includes("rust") || combined.includes("sqlite") || combined.includes("kernel") || combined.includes("database") || combined.includes("stack")) {
    return "architecture";
  }
  if (combined.includes("prefers") || combined.includes("theme") || combined.includes("light mode") || combined.includes("color") || combined.includes("style")) {
    return "preference";
  }
  if (combined.includes("harness") || combined.includes("supercharge") || combined.includes("workflow") || combined.includes("trigger") || combined.includes("pipeline")) {
    return "workflow";
  }
  return "domain_fact";
}

function loadStoredMeta(): Record<string, { category?: MemoryCategory; tags?: string[]; pinned?: boolean }> {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

export function Memory() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  // Global Scope & Active Engine
  const [globalScope, setGlobalScope] = useState<string>("Workspace default");
  const [activeEngine, setActiveEngine] = useState<string>(snap.memoryRoute?.engineId || "mem0_builtin");
  const [engineStatuses, setEngineStatuses] = useState<Record<string, boolean>>({
    mem0_builtin: true,
    zep_graphiti: false,
    cognee: false,
    letta: false,
    obsidian_khoj: Boolean(snap.settings?.obsidianVault?.trim()),
  });

  // Functional 1-Click Installer State
  const [installingEngine, setInstallingEngine] = useState<string | null>(null);
  const [installerEndpoint, setInstallerEndpoint] = useState<string>("http://127.0.0.1:8000");
  const [installerProbeStatus, setInstallerProbeStatus] = useState<"idle" | "probing" | "online" | "offline">("idle");
  const [installerProbeDetail, setInstallerProbeDetail] = useState<string>("");
  const [installerCopied, setInstallerCopied] = useState<boolean>(false);
  const [obsidianManualPath, setObsidianManualPath] = useState<string>(snap.settings?.obsidianVault || "");

  // Handler for 1-Click Install or Configure
  const handle1ClickInstall = async (engId: string) => {
    if (engId === "obsidian_khoj") {
      try {
        const picked = await pickPaths("folder");
        if (picked && picked.length > 0 && picked[0]) {
          const vaultPath = picked[0];
          await run("save_settings", { settings: { ...snap.settings, obsidianVault: vaultPath } });
          await run("scan_memory_engines");
          await run("refresh_memory_vault", { engineId: "obsidian_khoj" });
          setEngineStatuses((prev) => ({ ...prev, obsidian_khoj: true }));
          setStatusBanner(`✓ Connected Obsidian vault at: "${vaultPath}". Synced notes & [[wikilinks]].`);
          return;
        }
      } catch (err) {
        console.warn("Folder picker fallback:", err);
      }
      setObsidianManualPath(snap.settings?.obsidianVault || "");
      setInstallingEngine("obsidian_khoj");
    } else {
      const port = engId === "letta" ? "8283" : "8000";
      const defaultUrl = `http://127.0.0.1:${port}`;
      setInstallingEngine(engId);
      setInstallerCopied(false);
      setInstallerEndpoint(defaultUrl);
      setInstallerProbeStatus("probing");
      setInstallerProbeDetail(`Probing 127.0.0.1:${port}...`);

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1800);
        const res = await fetch(defaultUrl, { method: "GET", signal: ctrl.signal }).catch(() => null);
        clearTimeout(timer);
        if (res) {
          setInstallerProbeStatus("online");
          setInstallerProbeDetail(`Server responded (HTTP ${res.status}). Ready to connect!`);
        } else {
          setInstallerProbeStatus("offline");
          setInstallerProbeDetail(`No process answering on 127.0.0.1:${port}. Run the command below to launch.`);
        }
      } catch {
        setInstallerProbeStatus("offline");
        setInstallerProbeDetail(`No process answering on 127.0.0.1:${port}. Run the command below to launch.`);
      }
    }
  };

  // Mem0 Studio Sub-tabs
  const [vaultTab, setVaultTab] = useState<"organize" | "graph" | "extract" | "history" | "search_playground">("organize");

  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [journalState, setJournalState] = useState<"loading" | "ready" | "missing">("loading");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchNote, setSearchNote] = useState("");
  const [metaMap, setMetaMap] = useState(loadStoredMeta);

  useEffect(() => {
    try {
      localStorage.removeItem("ronic.mem0.graph_v2");
      localStorage.removeItem("ronic.mem0.history_v2");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(META_STORAGE_KEY, JSON.stringify(metaMap));
    } catch {}
  }, [metaMap]);

  // Merge SQLite/Snapshot memories with local metadata
  const atomicMemories: Mem0AtomicMemory[] = useMemo(() => {
    return (snap.memories || [])
      .filter((item) => !DEMO_MEMORY_IDS.has(item.id))
      .map((item) => {
      const customMeta = metaMap[item.id] || {};
      const cat = customMeta.category || inferCategory(item.title, item.contentMarkdown);
      const tags = item.wikilinks?.length ? item.wikilinks : customMeta.tags || [];
      const pinned = customMeta.pinned ?? false;
      const scopeLabel = !item.scopedBotId || item.scopedBotId === "global"
        ? "Workspace default"
        : snap.profiles.find((p) => p.id === item.scopedBotId)?.handle || item.scopedBotId;

      return {
        id: item.id,
        title: item.title,
        fact: item.contentMarkdown,
        category: cat,
        appliesTo: scopeLabel,
        source: item.sourceType || "manual",
        fileOrUri: item.filePathOrUri || "",
        tags,
        metadata: { engineOrigin: item.engineOrigin || "mem0_builtin" },
        confidence: 1,
        pinned,
        updatedAt: item.updatedAt ? when(item.updatedAt) : "Recently",
      };
    });
  }, [snap.memories, snap.profiles, metaMap]);

  // Tab 1: Organize & Edit State
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>("");
  const [isCreatingNew, setIsCreatingNew] = useState<boolean>(false);

  const selectedMemory = useMemo(() => {
    return atomicMemories.find((m) => m.id === selectedMemoryId) || atomicMemories[0];
  }, [atomicMemories, selectedMemoryId]);

  // Editor Fields
  const [editTitle, setEditTitle] = useState<string>(selectedMemory?.title || "");
  const [editFact, setEditFact] = useState<string>(selectedMemory?.fact || "");
  const [editCategory, setEditCategory] = useState<MemoryCategory>(selectedMemory?.category || "architecture");
  const [editSource, setEditSource] = useState<string>(selectedMemory?.source || "manual");
  const [editAppliesTo, setEditAppliesTo] = useState<string>(selectedMemory?.appliesTo || "Workspace default");
  const [editFileUri, setEditFileUri] = useState<string>(selectedMemory?.fileOrUri || "");
  const [editTags, setEditTags] = useState<string>(selectedMemory?.tags?.join(", ") || "");

  // Memories load asynchronously and the visible selection can change without
  // a click (first snapshot arrival, deletion of the selected note). Sync the
  // editor to the resolved selection; typing on an unchanged note is untouched.
  const resolvedMemoryId = selectedMemory?.id ?? "";
  useEffect(() => {
    if (isCreatingNew) return;
    const mem = selectedMemory;
    if (!mem) return;
    setEditTitle(mem.title);
    setEditFact(mem.fact);
    setEditCategory(mem.category);
    setEditSource(mem.source);
    setEditAppliesTo(mem.appliesTo);
    setEditFileUri(mem.fileOrUri);
    setEditTags(mem.tags.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rerun only when the selection identity changes
  }, [resolvedMemoryId]);

  // Tab 2: Graph Explorer State
  const [selectedGraphNode, setSelectedGraphNode] = useState<string | null>(null);
  const [newEdgeTarget, setNewEdgeTarget] = useState<string>("");

  // Tab 3: Smart Extractor State
  const [rawTextToExtract, setRawTextToExtract] = useState<string>("");

  // Tab 5: Search State
  const [playgroundQuery, setPlaygroundQuery] = useState<string>("");
  const [minScoreThreshold, setMinScoreThreshold] = useState<number>(0.05);
  const [includeGraphHop, setIncludeGraphHop] = useState<boolean>(true);

  const [statusBanner, setStatusBanner] = useState<string>(
    "Mem0 is the local vault in state.db. Notes you save here are the notes chat can recall."
  );

  const handleSelectMemory = (mem: Mem0AtomicMemory) => {
    setIsCreatingNew(false);
    setSelectedMemoryId(mem.id);
    setEditTitle(mem.title);
    setEditFact(mem.fact);
    setEditCategory(mem.category);
    setEditSource(mem.source);
    setEditAppliesTo(mem.appliesTo);
    setEditFileUri(mem.fileOrUri);
    setEditTags(mem.tags.join(", "));
  };

  const handleStartNewNote = () => {
    setIsCreatingNew(true);
    setVaultTab("organize");
    setEditTitle("");
    setEditFact("");
    setEditCategory("domain_fact");
    setEditSource("manual");
    setEditAppliesTo(globalScope);
    setEditFileUri("");
    setEditTags("");
  };

  function withTagLinks(body: string, tags: string[]) {
    let next = body.trim();
    for (const tag of tags) {
      const name = tag.replace(/[\[\]]/g, "").trim();
      if (!name || next.includes(`[[${name}]]`)) continue;
      next += `\n[[${name}]]`;
    }
    return next;
  }

  async function loadJournal() {
    const res = await run("memory_vault", { action: "journal", query: "" });
    const rows = listFromPayload(res?.payload, "events");
    if (!res || !rows) {
      setJournal([]);
      setJournalState(res ? "ready" : "missing");
      return;
    }
    setJournal(
      rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const item = row as Partial<JournalRow>;
        if (typeof item.id !== "string" || typeof item.memoryId !== "string") return [];
        if (DEMO_MEMORY_IDS.has(item.memoryId)) return [];
        return [{
          id: item.id,
          op: typeof item.op === "string" ? item.op : "remember",
          memoryId: item.memoryId,
          title: typeof item.title === "string" ? item.title : "",
          source: typeof item.source === "string" ? item.source : "",
          createdAt: Number(item.createdAt) || 0,
        }];
      }),
    );
    setJournalState("ready");
  }

  useEffect(() => {
    void loadJournal();
  }, []);

  useEffect(() => {
    const query = playgroundQuery.trim();
    if (!query) {
      setSearchHits([]);
      setSearchNote("");
      return;
    }
    const timer = window.setTimeout(() => {
      void run("memory_vault", { action: "search", query }).then((res) => {
        const rows = listFromPayload(res?.payload, "hits");
        if (!res || !rows) {
          setSearchHits([]);
          setSearchNote(res?.toast || "Vault search did not run. Restart the desktop app so this command is loaded.");
          return;
        }
        const hits = rows.flatMap((row) => {
          if (!row || typeof row !== "object") return [];
          const item = row as Partial<SearchHit>;
          if (typeof item.id !== "string" || DEMO_MEMORY_IDS.has(item.id)) return [];
          const score = Number(item.score);
          if (!Number.isFinite(score) || score < minScoreThreshold) return [];
          return [{
            id: item.id,
            title: typeof item.title === "string" ? item.title : item.id,
            content: typeof item.content === "string" ? item.content : "",
            score,
          }];
        });
        setSearchHits(hits);
        setSearchNote(hits.length === 0 ? "No saved note reached that score." : res.toast || "");
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [playgroundQuery, minScoreThreshold]);

  const graphEdges: Mem0GraphEdge[] = useMemo(() => {
    const edges: Mem0GraphEdge[] = [];
    for (const item of snap.memories || []) {
      if (DEMO_MEMORY_IDS.has(item.id)) continue;
      for (const link of item.wikilinks || []) {
        const name = link.trim();
        if (!name) continue;
        edges.push({
          id: `${item.id}:${name}`,
          source: item.title || item.id,
          sourceType: "note",
          relation: "LINKS",
          target: name,
          targetType: "wikilink",
          memoryId: item.id,
          appliesTo: item.scopedBotId || "Workspace default",
        });
      }
    }
    return edges;
  }, [snap.memories]);

  async function saveNote(id: string | null, title: string, content: string, source: string, filePath: string, scopedBotId: string | null) {
    return run("save_memory", {
      draft: {
        id,
        title,
        contentMarkdown: content,
        sourceType: source,
        scopedBotId,
        filePathOrUri: filePath,
        engineId: snap.memoryRoute?.engineId || "mem0_builtin",
      },
    });
  }

  // Save or update memory (synced to state.db via run("save_memory"))
  const handleSaveOrUpdateMemory = async () => {
    if (!editFact.trim()) return;
    const parsedTags = editTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const content = withTagLinks(editFact, parsedTags);
    const targetBotProfile = snap.profiles.find((p) => p.handle === editAppliesTo || p.id === editAppliesTo);
    const scopedBotId = editAppliesTo === "Workspace default" ? null : targetBotProfile?.id || null;

    if (isCreatingNew) {
      const titleToSave = editTitle.trim() || editFact.slice(0, 42);
      const res = await saveNote(null, titleToSave, content, editSource, editFileUri.trim(), scopedBotId);
      const saved = res?.snapshot.memories.find((item) => item.title === titleToSave && item.contentMarkdown === content);
      if (saved) {
        setMetaMap((prev) => ({
          ...prev,
          [saved.id]: { category: editCategory, tags: parsedTags, pinned: false },
        }));
        setSelectedMemoryId(saved.id);
      }
      setIsCreatingNew(false);
      setStatusBanner(res?.toast || `Saved "${titleToSave}" in the local vault.`);
      await loadJournal();
    } else if (selectedMemory) {
      const res = await saveNote(
        selectedMemory.id,
        editTitle.trim() || selectedMemory.title,
        content,
        editSource,
        editFileUri.trim(),
        scopedBotId,
      );
      setMetaMap((prev) => ({
        ...prev,
        [selectedMemory.id]: {
          ...prev[selectedMemory.id],
          category: editCategory,
          tags: parsedTags,
        },
      }));
      setStatusBanner(res?.toast || `Updated "${selectedMemory.title}" in the local vault.`);
      await loadJournal();
    }
  };

  const handleDeleteMemory = async (id: string) => {
    const res = await run("delete_memory", { id, engineId: snap.memoryRoute?.engineId || "mem0_builtin" });
    setStatusBanner(res?.toast || `Deleted memory ${id} from state.db.`);
    await loadJournal();
  };

  async function linkSelectedNote(target: string) {
    if (!selectedMemory) return;
    const name = target.replace(/[\[\]]/g, "").trim();
    if (!name) return;
    const content = selectedMemory.fact.includes(`[[${name}]]`) ? selectedMemory.fact : `${selectedMemory.fact.trim()}\n[[${name}]]`;
    const targetBotProfile = snap.profiles.find((p) => p.handle === selectedMemory.appliesTo || p.id === selectedMemory.appliesTo);
    const scopedBotId = selectedMemory.appliesTo === "Workspace default" ? null : targetBotProfile?.id || null;
    const res = await saveNote(selectedMemory.id, selectedMemory.title, content, selectedMemory.source, selectedMemory.fileOrUri, scopedBotId);
    setStatusBanner(res?.toast || `Linked [[${name}]] on "${selectedMemory.title}".`);
    await loadJournal();
  }

  async function unlinkEdge(edge: Mem0GraphEdge) {
    const note = (snap.memories || []).find((item) => item.id === edge.memoryId);
    if (!note) return;
    const content = note.contentMarkdown.split(`[[${edge.target}]]`).join("").replace(/\n{3,}/g, "\n\n").trim();
    const res = await saveNote(note.id, note.title, content, note.sourceType || "manual", note.filePathOrUri || "", note.scopedBotId);
    setStatusBanner(res?.toast || `Removed [[${edge.target}]].`);
    await loadJournal();
  }

  // Smart Fact & Graph Extractor
  const handleSmartExtractFromText = async () => {
    if (!rawTextToExtract.trim()) return;
    const sentences = rawTextToExtract
      .split(/(?<=[.?!])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    let saved = 0;
    for (const sentence of sentences) {
      const isBot = /@(\w[\w-]*)/.exec(sentence);
      const targetScope = isBot ? `@${isBot[1]}` : globalScope;
      const title = sentence.slice(0, 44) + (sentence.length > 44 ? "..." : "");
      const targetBotProfile = snap.profiles.find((p) => p.handle === targetScope || p.id === targetScope);
      const scopedBotId = targetScope === "Workspace default" ? null : targetBotProfile?.id || null;
      const res = await saveNote(null, title, sentence, "smart_extract", "", scopedBotId);
      if (res) saved += 1;
    }
    setVaultTab("organize");
    setStatusBanner(saved > 0 ? `Saved ${saved} note(s) from that text into the local vault.` : "Those sentences were not saved. Restart the desktop app if save did not run.");
    await loadJournal();
  };

  // Filtered Memories for Left List
  const filteredMemories = useMemo(() => {
    return atomicMemories.filter((m) => {
      const matchesScope =
        globalScope === "Workspace default" ||
        m.appliesTo === globalScope ||
        m.appliesTo === "Workspace default";
      const matchesCat = selectedCategory === "all" || m.category === selectedCategory;
      const needle = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !needle ||
        m.title.toLowerCase().includes(needle) ||
        m.fact.toLowerCase().includes(needle) ||
        m.tags.some((t) => t.toLowerCase().includes(needle));
      return matchesScope && matchesCat && matchesSearch;
    });
  }, [atomicMemories, globalScope, selectedCategory, searchQuery]);

  // Compute 2D SVG Graph Layout
  const graphLayout = useMemo(() => {
    const nodeNames = Array.from(new Set(graphEdges.flatMap((e) => [e.source, e.target])));
    const centerX = 360;
    const centerY = 175;
    const radius = 130;

    const nodes = nodeNames.map((name, idx) => {
      if (idx === 0) {
        return { name, x: centerX, y: centerY };
      }
      const angle = ((idx - 1) / Math.max(1, nodeNames.length - 1)) * 2 * Math.PI;
      return {
        name,
        x: Math.round(centerX + radius * Math.cos(angle)),
        y: Math.round(centerY + radius * Math.sin(angle)),
      };
    });

    return { nodes, edges: graphEdges };
  }, [graphEdges]);

  // Engines Configuration List
  const engines = [
    {
      id: "mem0_builtin",
      name: "Mem0 (built in)",
      desc: "Local Mem0 + Mem0g Graph vault in state.db. No extra process.",
      builtIn: true,
    },
    {
      id: "zep_graphiti",
      name: "Zep (Graphiti)",
      desc: "Bi-temporal knowledge graph on 127.0.0.1:8000.",
      builtIn: false,
    },
    {
      id: "cognee",
      name: "Cognee",
      desc: "Vector + Relational + Graph ECL pipeline on 127.0.0.1:8000.",
      builtIn: false,
    },
    {
      id: "letta",
      name: "Letta",
      desc: "Stateful self-editing agent blocks on 127.0.0.1:8283.",
      builtIn: false,
    },
    {
      id: "obsidian_khoj",
      name: "Obsidian",
      desc: "Local Markdown vault and [[Wikilinks]] via MCP.",
      builtIn: false,
    },
  ];

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        {/* Top Header inside Floating White Card */}
        <div className="p-5 sm:p-7 pb-4 space-y-4 border-b border-slate-100 bg-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 max-w-2xl">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Memory</h1>
              <p className="text-xs text-[#64748B]">
                Manage the vault selected for this scope. Mem0 stays local to the workspace (<code>state.db</code>);
                includes Atomic Facts, Mem0g Entity Graph, Smart Extraction, and Mutation History.
              </p>
              <p className="text-xs font-mono text-emerald-700 pt-0.5">{statusBanner}</p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                disabled={busy}
                onClick={() => {
                  void run("scan_memory_engines").then((res) => {
                    setStatusBanner(res?.toast || "Scan finished.");
                  });
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-slate-400 transition cursor-pointer shadow-2xs"
              >
                Scan desktop
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void run("refresh_memory_vault", { engineId: activeEngine }).then((res) => {
                    setStatusBanner(res ? (res.toast || `Refreshed state.db: ${atomicMemories.length} atomic memories & ${graphEdges.length} graph edges.`) : "Could not refresh the vault.");
                  });
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-slate-400 transition cursor-pointer shadow-2xs"
              >
                Refresh vault
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void run("sync_memories_to_engine", { targetEngineId: "obsidian_khoj" }).then((res) => {
                    setStatusBanner(res ? (res.toast || `Exported ${atomicMemories.length} Mem0 facts and [[Wikilinks]] graph edges to Obsidian vault.`) : "Could not export to Obsidian.");
                  });
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-slate-400 transition cursor-pointer shadow-2xs"
              >
                Copy Mem0 to Obsidian
              </button>
              <button
                onClick={handleStartNewNote}
                className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 rounded-[6px] transition flex items-center gap-1.5 shadow-xs cursor-pointer active:scale-95"
              >
                <Plus size={14} className="text-white" stroke="#ffffff" />
                <span>New memory</span>
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable Content inside Floating White Card */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-7 space-y-6">

      {/* =====================================================================
          2. SCOPE SELECTOR & 5 ENGINE CARDS
         ===================================================================== */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-[#64748B] block">Applies to</label>
        <select
          value={globalScope}
          onChange={(e) => {
            setGlobalScope(e.target.value);
            setSelectedMemoryId("");
          }}
          className="w-full px-3 py-2 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 shadow-sm"
        >
          <option value="Workspace default">Workspace default (All Bots & Connected Harnesses)</option>
          {snap.profiles.map((p) => (
            <option key={p.id} value={p.handle || p.id}>
              {p.handle} ({p.role || "Scoped Bot"})
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {engines.map((eng) => {
          const isInstalled =
            eng.builtIn ||
            engineStatuses[eng.id] ||
            snap.memoryEngines?.some(
              (me) => me.id === eng.id && (me.availability === "detected" || me.availability === "builtin")
            ) ||
            (eng.id === "obsidian_khoj" && Boolean(snap.settings?.obsidianVault?.trim()));
          const isCurrent = activeEngine === eng.id;
          return (
            <div
              key={eng.id}
              className={`bg-white rounded-[8px] p-3.5 border transition flex flex-col justify-between gap-3 shadow-xs ${
                isCurrent ? "border-slate-400 ring-1 ring-slate-300 shadow-sm" : "border-[#E5E5E5] hover:border-slate-300"
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-xs font-bold text-[#0F172A] truncate">{eng.name}</span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      isCurrent
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : isInstalled
                        ? "bg-slate-100 text-[#0F172A]"
                        : "bg-slate-100 text-[#64748B]"
                    }`}
                  >
                    {isCurrent ? "Active" : isInstalled ? "Installed" : "Not installed"}
                  </span>
                </div>
                <p className="text-[11px] text-[#64748B] mt-1.5 leading-snug">{eng.desc}</p>
              </div>

              <div className="flex items-center gap-1.5 pt-1">
                {isCurrent ? (
                  <button
                    disabled
                    className="px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-300 rounded-[4px] cursor-default flex items-center gap-1"
                  >
                    <Check size={11} /> Active
                  </button>
                ) : isInstalled ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setActiveEngine(eng.id);
                        void run("set_memory_route", {
                          scope: globalScope === "Workspace default" ? "global" : globalScope,
                          engineId: eng.id,
                        });
                        setStatusBanner(`⚡ Switched active memory route to ${eng.name}.`);
                      }}
                      className="px-2.5 py-1 text-[11px] font-semibold border border-slate-300 text-slate-700 rounded-[4px] hover:bg-slate-100 transition"
                    >
                      Switch
                    </button>
                    {!eng.builtIn && (
                      <button
                        onClick={() => handle1ClickInstall(eng.id)}
                        className="px-2 py-1 text-[11px] font-medium border border-transparent text-slate-500 hover:text-slate-800 rounded-[4px] transition"
                        title="Configure endpoint or vault"
                      >
                        Config
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => handle1ClickInstall(eng.id)}
                    className="px-2.5 py-1 text-[11px] font-semibold border border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-slate-400 rounded-[4px] transition text-slate-700 flex items-center gap-1 shadow-2xs"
                  >
                    {eng.id === "obsidian_khoj" ? <Folder size={11} /> : <Download size={11} />}
                    {eng.id === "obsidian_khoj" ? "Pick Vault" : "Connect"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* =====================================================================
          3. UPGRADED MEM0 (BUILT IN) INTERACTIVE VAULT STUDIO (`state.db`)
         ===================================================================== */}
      <div className="bg-white border border-[#E5E5E5] rounded-[10px] p-5 space-y-4 shadow-sm">
        {/* Vault Header + Interactive Navigation Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E5E5] pb-3">
          <div className="flex items-center gap-2.5">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-[#0F172A]">Mem0 (built in) vault</h2>
                <span className="px-2 py-0.5 text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                  {atomicMemories.length} atomic memories
                </span>
                <span className="px-2 py-0.5 text-[11px] font-mono bg-[#F8FAFC] text-[#0F172A] border border-[#E5E5E5] rounded-full">
                  {graphEdges.length} wikilinks
                </span>
              </div>
              <div className="text-[11px] font-mono text-[#64748B] mt-0.5">
                state.db • notes saved on this computer
              </div>
            </div>
          </div>

          {/* 5 Interactive Feature Tabs */}
          <div className="flex flex-wrap items-center gap-1 bg-[#F1F5F9] p-1 rounded-[8px] border border-[#E2E8F0]">
            {[
              { id: "organize", label: "🗂️ Organize & Edit" },
              { id: "graph", label: "🕸️ Wikilinks" },
              { id: "extract", label: "⚡ Split into notes" },
              { id: "history", label: `🕒 History (${journal.length})` },
              { id: "search_playground", label: "🔍 Search" },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setVaultTab(t.id as any)}
                className={`px-3 py-1.5 text-xs rounded-[6px] transition ${
                  vaultTab === t.id
                    ? "bg-white text-slate-800 shadow-xs border border-slate-300/80 font-bold"
                    : "text-slate-600 hover:text-slate-900 hover:bg-white/60 font-medium"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ===================================================================
            TAB 1: ORGANIZE, FILTER & EDIT ATOMIC MEMORIES
           =================================================================== */}
        {vaultTab === "organize" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* LEFT COLUMN (5 Cols): Search, Categories, Memory List */}
            <div className="lg:col-span-5 space-y-3 border-r border-[#E5E5E5] pr-4">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-2.5 text-[#94A3B8]" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search facts, tags, or @bot scope in this vault..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 bg-white"
                />
              </div>

              {/* Category Filter Pills */}
              <div className="flex flex-wrap gap-1">
                {[
                  { id: "all", label: "All" },
                  { id: "architecture", label: "Architecture" },
                  { id: "preference", label: "Preferences" },
                  { id: "workflow", label: "Workflows" },
                  { id: "quant_rule", label: "Quant Rules" },
                  { id: "domain_fact", label: "Facts" },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`px-2.5 py-1 text-[11px] rounded-full border transition ${
                      selectedCategory === cat.id
                        ? "bg-slate-200 text-slate-800 border-slate-300 font-bold shadow-xs"
                        : "bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:border-slate-300"
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {/* Memory Cards List */}
              <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                {filteredMemories.length === 0 ? (
                  <div className="p-6 text-center text-xs text-[#64748B] border border-dashed border-[#E5E5E5] rounded-[6px]">
                    {atomicMemories.length === 0 ? "No notes yet. Save one and it stays in the local vault." : "No matching memories found for this filter."}
                  </div>
                ) : (
                  filteredMemories.map((mem) => {
                    const isSelected = !isCreatingNew && mem.id === selectedMemory?.id;
                    return (
                      <div
                        key={mem.id}
                        onClick={() => handleSelectMemory(mem)}
                        className={`p-3 rounded-[6px] border cursor-pointer transition space-y-1.5 ${
                          isSelected
                            ? "border-slate-400 bg-slate-50/90 shadow-xs border-l-4 border-l-slate-600"
                            : "border-[#E5E5E5] bg-white hover:bg-[#F8FAFC]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-[#0F172A] truncate flex items-center gap-1">
                            {mem.pinned && <span title="Pinned fact">📌</span>}
                            {mem.title}
                          </span>
                          <span className="px-1.5 py-0.5 text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 rounded shrink-0">
                            {mem.category}
                          </span>
                        </div>

                        <p className="text-xs text-[#64748B] line-clamp-2 leading-relaxed">{mem.fact}</p>

                        <div className="flex flex-wrap items-center justify-between gap-1 pt-1 text-[10px] font-mono text-[#64748B]">
                          <span>
                            {mem.appliesTo} • via {mem.source}
                          </span>
                          <span>{mem.updatedAt}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* RIGHT COLUMN (7 Cols): Dual-Mode Editor & Linked Triplets */}
            <div className="lg:col-span-7 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-[#0F172A]">
                  {isCreatingNew ? "Create New Mem0 Atomic Memory" : `Edit Memory (${selectedMemory?.id || "None"})`}
                </h3>
                <div className="flex items-center gap-1.5">
                  {!isCreatingNew && selectedMemory && (
                    <>
                      <button
                        onClick={() => {
                          const newPinned = !selectedMemory.pinned;
                          setMetaMap((prev) => ({
                            ...prev,
                            [selectedMemory.id]: {
                              ...prev[selectedMemory.id],
                              pinned: newPinned,
                            },
                          }));
                          setStatusBanner(`${newPinned ? "📌 Pinned" : "Unpinned"} memory ${selectedMemory.id}.`);
                        }}
                        className="px-2.5 py-1 text-[11px] font-semibold border border-[#E5E5E5] rounded hover:border-slate-400 transition bg-white"
                      >
                        {selectedMemory.pinned ? "📌 Unpin" : "📌 Pin Fact"}
                      </button>
                      <button
                        onClick={() => handleDeleteMemory(selectedMemory.id)}
                        className="px-2.5 py-1 text-[11px] font-semibold border border-[#E5E5E5] text-rose-600 rounded hover:bg-rose-50 transition bg-white"
                      >
                        Delete
                      </button>
                    </>
                  )}
                  <span className="px-2 py-0.5 text-[11px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 rounded font-semibold">
                    Mem0
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="font-semibold text-[#64748B] block mb-1">Title</label>
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Short summary title..."
                    className="w-full px-3 py-1.5 border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 bg-white"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#64748B] block mb-1">Source</label>
                  <select
                    value={editSource}
                    onChange={(e) => setEditSource(e.target.value)}
                    className="w-full px-3 py-1.5 border border-[#E5E5E5] rounded-[6px] bg-white outline-none focus:border-slate-400"
                  >
                    <option value="manual">manual</option>
                    <option value="smart_extract">smart_extract (Mem0 Pipeline)</option>
                    <option value="claude_cli">claude_cli (MCP)</option>
                    <option value="cursor">cursor (MCP)</option>
                    <option value="opencode">opencode (ACP)</option>
                  </select>
                </div>
                <div>
                  <label className="font-semibold text-[#64748B] block mb-1">Applies to (Scope)</label>
                  <select
                    value={editAppliesTo}
                    onChange={(e) => setEditAppliesTo(e.target.value)}
                    className="w-full px-3 py-1.5 border border-[#E5E5E5] rounded-[6px] bg-white outline-none focus:border-slate-400"
                  >
                    <option value="Workspace default">Workspace default</option>
                    {snap.profiles.map((p) => (
                      <option key={p.id} value={p.handle || p.id}>
                        {p.handle}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-semibold text-[#64748B] block mb-1">Category</label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                    className="w-full px-3 py-1.5 border border-[#E5E5E5] rounded-[6px] bg-white outline-none focus:border-slate-400"
                  >
                    <option value="architecture">architecture</option>
                    <option value="preference">preference</option>
                    <option value="workflow">workflow</option>
                    <option value="quant_rule">quant_rule</option>
                    <option value="domain_fact">domain_fact</option>
                  </select>
                </div>
                <div>
                  <label className="font-semibold text-[#64748B] block mb-1">File or URI</label>
                  <input
                    value={editFileUri}
                    onChange={(e) => setEditFileUri(e.target.value)}
                    placeholder="e.g. src-tauri/src/main.rs"
                    className="w-full px-3 py-1.5 font-mono border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 bg-white"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#64748B] block mb-1">Metadata Tags</label>
                  <input
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    placeholder="tauri-v2, rust, wallet"
                    className="w-full px-3 py-1.5 font-mono border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-[#64748B] block mb-1">
                  Atomic Fact Content (Indexed into SQLite WAL & Mem0 Vector/Graph)
                </label>
                <textarea
                  rows={4}
                  value={editFact}
                  onChange={(e) => setEditFact(e.target.value)}
                  placeholder="Write an atomic memory or rule..."
                  className="w-full p-3 text-xs border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 bg-white leading-relaxed"
                />
              </div>

              {/* Linked Mem0g Triplets */}
              {!isCreatingNew && selectedMemory && (
                <div className="p-2.5 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-bold text-[#64748B]">
                    <span>🕸️ Linked Mem0g Entity Triplets:</span>
                    <button onClick={() => setVaultTab("graph")} className="text-[#0F172A] underline hover:text-slate-800">
                      Open in Graph View →
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {graphEdges
                      .filter((e) => e.memoryId === selectedMemory.id)
                      .map((e) => (
                        <span key={e.id} className="px-2 py-0.5 text-[11px] font-mono bg-white border border-[#E5E5E5] rounded">
                          ({e.source}) —[{e.relation}]→ ({e.target})
                        </span>
                      ))}
                    {graphEdges.filter((e) => e.memoryId === selectedMemory.id).length === 0 && (
                      <span className="text-[11px] text-[#94A3B8]">No direct graph triplet linked yet.</span>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  disabled={busy || !editFact.trim()}
                  onClick={handleSaveOrUpdateMemory}
                  className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs rounded-[6px] transition flex items-center gap-1.5 shadow-xs"
                  style={{ color: "#ffffff" }}
                >
                  <Check size={14} className="text-white" stroke="#ffffff" />
                  <span className="text-white" style={{ color: "#ffffff" }}>
                    {isCreatingNew ? "Save memory to Mem0" : "Update memory & Log diff"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 2: INTERACTIVE GRAPH VIEW (Mem0g Explorer)
           =================================================================== */}
        {vaultTab === "graph" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* 2D Knowledge Graph SVG Canvas */}
            <div className="lg:col-span-8 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] p-3 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-bold text-[#0F172A] flex items-center gap-1.5">
                  <Network size={14} /> Wikilinks saved on these notes (<code>state.db</code>)
                </span>
                <span className="text-[11px] font-mono text-[#64748B]">Click any node to inspect connected facts</span>
              </div>

              <svg className="w-full h-[370px] bg-white border border-[#E5E5E5] rounded-[6px]">
                {/* Directed Edges */}
                {graphLayout.edges.map((edge) => {
                  const s = graphLayout.nodes.find((n) => n.name === edge.source);
                  const t = graphLayout.nodes.find((n) => n.name === edge.target);
                  if (!s || !t) return null;
                  const midX = (s.x + t.x) / 2;
                  const midY = (s.y + t.y) / 2;
                  return (
                    <g key={edge.id}>
                      <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#CBD5E1" strokeWidth={1.8} />
                      <rect x={midX - 44} y={midY - 9} width={88} height={16} rx={3} fill="#F8FAFC" stroke="#E5E5E5" />
                      <text
                        x={midX}
                        y={midY + 2}
                        textAnchor="middle"
                        fontSize="9"
                        fontFamily="JetBrains Mono, monospace"
                        fill="#475569"
                        fontWeight="600"
                      >
                        {edge.relation}
                      </text>
                    </g>
                  );
                })}

                {/* Interactive Entity Nodes */}
                {graphLayout.nodes.map((node) => {
                  const isSelected = selectedGraphNode === node.name;
                  return (
                    <g key={node.name} onClick={() => setSelectedGraphNode(node.name)} className="cursor-pointer">
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={isSelected ? 22 : 18}
                        fill={isSelected ? "#475569" : "#FFFFFF"}
                        stroke={isSelected ? "#334155" : "#94A3B8"}
                        strokeWidth={2}
                      />
                      <text
                        x={node.x}
                        y={node.y + 32}
                        textAnchor="middle"
                        fontSize="11"
                        fontWeight="600"
                        fill="#0F172A"
                      >
                        {node.name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Right Graph Inspector & Add Edge Form */}
            <div className="lg:col-span-4 space-y-4 text-xs">
              <div className="p-3.5 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] space-y-2">
                <div className="font-bold text-sm text-[#0F172A]">
                  Selected Entity: <span className="font-mono text-emerald-800">{selectedGraphNode}</span>
                </div>
                <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                  {graphEdges
                    .filter((e) => e.source === selectedGraphNode || e.target === selectedGraphNode)
                    .map((edge) => (
                      <div
                        key={edge.id}
                        className="p-2 bg-white border border-[#E5E5E5] rounded flex items-center justify-between font-mono text-[11px]"
                      >
                        <span>
                          {edge.source} → <strong>{edge.relation}</strong> → {edge.target}
                        </span>
                        <button
                          onClick={() => void unlinkEdge(edge)}
                          className="text-rose-500 font-bold ml-2 hover:text-rose-700"
                          title="Remove this wikilink from the note"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  {graphEdges.filter((e) => e.source === selectedGraphNode || e.target === selectedGraphNode).length === 0 && (
                    <p className="text-[#94A3B8] text-[11px]">No active relations for this entity.</p>
                  )}
                </div>
              </div>

              {/* Add New Relationship Triplet */}
              <div className="p-3.5 bg-white border border-[#E5E5E5] rounded-[6px] space-y-2.5">
                <div className="font-bold text-[#0F172A] flex items-center gap-1.5">
                  <Plus size={14} /> Link the selected note
                </div>
                <p className="text-[11px] text-[#64748B]">Writes [[name]] into {selectedMemory ? selectedMemory.title : "the open note"} and saves it in state.db.</p>
                <input
                  value={newEdgeTarget}
                  onChange={(e) => setNewEdgeTarget(e.target.value)}
                  placeholder="Name to link"
                  className="w-full px-2.5 py-1.5 border border-[#E5E5E5] rounded font-mono text-xs outline-none focus:border-slate-400"
                />
                <button
                  onClick={() => {
                    if (!newEdgeTarget.trim() || !selectedMemory) return;
                    void linkSelectedNote(newEdgeTarget);
                    setSelectedGraphNode(selectedMemory.title);
                    setNewEdgeTarget("");
                  }}
                  disabled={!selectedMemory}
                  className="w-full py-1.5 font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs rounded-[6px] transition text-xs shadow-xs disabled:opacity-40"
                  style={{ color: "#ffffff" }}
                >
                  <span className="text-white" style={{ color: "#ffffff" }}>Save wikilink</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 3: SMART FACT & GRAPH EXTRACTOR
           =================================================================== */}
        {vaultTab === "extract" && (
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px]">
              <div className="font-bold text-sm text-[#0F172A] flex items-center gap-1.5">
                <Sparkles size={14} className="text-amber-500" /> Mem0 Smart Fact & Entity Extractor (<code>memory.add</code>)
              </div>
              <p className="text-[#64748B] mt-0.5">
                Paste text. Each sentence longer than a few words is saved as its own note in the local vault.
              </p>
            </div>
            <textarea
              rows={5}
              value={rawTextToExtract}
              onChange={(e) => setRawTextToExtract(e.target.value)}
              className="w-full p-3 font-mono text-xs border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400 bg-white leading-relaxed"
            />
            <button
              onClick={handleSmartExtractFromText}
              className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs rounded-[6px] transition flex items-center gap-1.5 shadow-xs"
              style={{ color: "#ffffff" }}
            >
              <Sparkles size={14} className="text-white" stroke="#ffffff" />
              <span className="text-white" style={{ color: "#ffffff" }}>
                Save each sentence as a note
              </span>
            </button>
          </div>
        )}

        {/* ===================================================================
            TAB 4: MUTATION HISTORY & REVERT
           =================================================================== */}
        {vaultTab === "history" && (
          <div className="space-y-2.5 text-xs">
            {journalState === "missing" ? (
              <div className="p-6 text-center text-xs text-[#64748B] border border-dashed border-[#E5E5E5] rounded-[6px]">
                The journal is in state.db. Restart the desktop app so this screen can read it.
              </div>
            ) : journal.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#64748B] border border-dashed border-[#E5E5E5] rounded-[6px]">
                No edits yet. Saving or deleting a note records it in state.db.
              </div>
            ) : null}
            {journal.map((event) => (
              <div
                key={event.id}
                className="p-3 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px]"
              >
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="px-2 py-0.5 font-bold bg-slate-200 text-slate-800 border border-slate-300 rounded-[4px]">
                    {event.op}
                  </span>
                  <span className="font-bold text-[#0F172A]">{event.title || event.memoryId}</span>
                  <span className="text-[#64748B]">
                    {event.source ? `${event.source} · ` : ""}{event.createdAt ? when(event.createdAt) : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ===================================================================
            TAB 5: HYBRID VECTOR + GRAPH SEARCH PLAYGROUND
           =================================================================== */}
        {vaultTab === "search_playground" && (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
              <input
                value={playgroundQuery}
                onChange={(e) => setPlaygroundQuery(e.target.value)}
                placeholder="Words from a saved note"
                className="md:col-span-7 px-3 py-2 border border-[#E5E5E5] rounded-[6px] font-mono text-xs outline-none focus:border-slate-400 bg-white"
              />
              <div className="md:col-span-3 flex items-center gap-2">
                <span className="font-mono text-[11px] text-[#64748B] shrink-0">Min Score: {minScoreThreshold}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={minScoreThreshold}
                  onChange={(e) => setMinScoreThreshold(Number(e.target.value))}
                  className="w-full accent-slate-600"
                />
              </div>
              <label className="md:col-span-2 flex items-center gap-1.5 font-mono text-[11px] text-[#334155] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeGraphHop}
                  onChange={(e) => setIncludeGraphHop(e.target.checked)}
                  className="accent-slate-600"
                />
                <span>Show wikilinks</span>
              </label>
            </div>

            <div className="space-y-2">
              {playgroundQuery.trim().length === 0 ? (
                <div className="p-6 text-center text-xs text-[#64748B] border border-dashed border-[#E5E5E5] rounded-[6px]">
                  Type a few words. Scores use the same local embedding that chat uses to recall notes.
                </div>
              ) : searchNote ? (
                <p className="text-[11px] text-[#64748B]">{searchNote}</p>
              ) : null}
              {searchHits.map((hit) => {
                const linkedEdges = graphEdges.filter((edge) => edge.memoryId === hit.id);
                return (
                  <div
                    key={hit.id}
                    className="p-3 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] flex flex-col md:flex-row md:items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="font-bold text-[#0F172A]">{hit.title}</div>
                      <div className="text-[#64748B] text-xs">{hit.content}</div>
                      {includeGraphHop && linkedEdges.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {linkedEdges.map((edge) => (
                            <span key={edge.id} className="text-[10px] font-mono bg-white px-1.5 py-0.5 border border-[#CBD5E1] rounded text-[#334155]">
                              [[{edge.target}]]
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="px-2.5 py-1 font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded shrink-0 self-start md:self-auto">
                      Score: {hit.score.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* =====================================================================
          4. FUNCTIONAL 1-CLICK INSTALL & CONNECTION MODAL
         ===================================================================== */}
      {installingEngine && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
          onClick={() => setInstallingEngine(null)}
        >
          <div
            className="bg-white border border-[#E5E5E5] rounded-[12px] shadow-2xl max-w-lg w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-[#E5E5E5] flex items-center justify-between bg-[#F8FAFC]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-white border border-[#E2E8F0] rounded-[8px] text-slate-700 shadow-2xs">
                  {installingEngine === "obsidian_khoj" ? <Folder size={18} /> : <Server size={18} />}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#0F172A]">
                    {installingEngine === "obsidian_khoj"
                      ? "Connect Obsidian Markdown Vault"
                      : installingEngine === "zep_graphiti"
                      ? "Connect Zep (Graphiti) Knowledge Graph"
                      : installingEngine === "cognee"
                      ? "Connect Cognee ECL Memory Engine"
                      : "Connect Letta Stateful Agent Memory"}
                  </h3>
                  <p className="text-[11px] text-[#64748B]">
                    {installingEngine === "obsidian_khoj"
                      ? "Select your local Obsidian directory for bidirectional sync & [[wikilinks]]."
                      : "Configure real connection to local or remote memory server."}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setInstallingEngine(null)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded hover:bg-slate-200 transition"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 space-y-4">
              {installingEngine === "obsidian_khoj" ? (
                /* Obsidian Vault Connector */
                <div className="space-y-3.5">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-[8px] space-y-1.5 text-xs text-slate-700">
                    <p className="font-semibold text-slate-900 flex items-center gap-1.5">
                      <Folder size={14} className="text-slate-600" /> Local Markdown Vault
                    </p>
                    <p className="text-[11px] leading-relaxed text-[#64748B]">
                      Ronic OS connects directly to your local markdown vault on disk. No cloud sync or registration required.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-700">Vault Folder Path</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={obsidianManualPath}
                        onChange={(e) => setObsidianManualPath(e.target.value)}
                        placeholder="e.g. C:\Users\YourName\Documents\ObsidianVault"
                        className="flex-1 px-3 py-2 text-xs font-mono bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const picked = await pickPaths("folder");
                            if (picked && picked[0]) setObsidianManualPath(picked[0]);
                          } catch {}
                        }}
                        className="px-3 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-[6px] transition flex items-center gap-1.5 shrink-0"
                      >
                        <Folder size={13} /> Browse...
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#E5E5E5]">
                    <button
                      type="button"
                      onClick={() => setInstallingEngine(null)}
                      className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-[6px] transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!obsidianManualPath.trim()}
                      onClick={async () => {
                        const path = obsidianManualPath.trim();
                        await run("save_settings", { settings: { ...snap.settings, obsidianVault: path } });
                        await run("scan_memory_engines");
                        await run("refresh_memory_vault", { engineId: "obsidian_khoj" });
                        setEngineStatuses((prev) => ({ ...prev, obsidian_khoj: true }));
                        setStatusBanner(`✓ Connected Obsidian vault at: "${path}". Synced notes & [[wikilinks]].`);
                        setInstallingEngine(null);
                      }}
                      className="px-4 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs rounded-[6px] transition disabled:opacity-50 flex items-center gap-1.5"
                      style={{ color: "#ffffff" }}
                    >
                      <Check size={13} className="text-white" stroke="#ffffff" />
                      <span className="text-white" style={{ color: "#ffffff" }}>Connect Vault & Sync</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* Zep / Cognee / Letta Real Connector */
                <div className="space-y-4">
                  {/* Real Live Port / Health Probe */}
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-[8px] flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            installerProbeStatus === "online"
                              ? "bg-emerald-500 ring-2 ring-emerald-200"
                              : installerProbeStatus === "probing"
                              ? "bg-amber-500 animate-pulse"
                              : "bg-slate-400"
                          }`}
                        />
                        <span className="text-slate-800">
                          {installerProbeStatus === "online"
                            ? "Engine Server Online"
                            : installerProbeStatus === "probing"
                            ? "Probing Local Port..."
                            : "Server Not Responding"}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#64748B]">{installerProbeDetail}</p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        setInstallerProbeStatus("probing");
                        setInstallerProbeDetail(`Testing connection to ${installerEndpoint}...`);
                        try {
                          const ctrl = new AbortController();
                          const t = setTimeout(() => ctrl.abort(), 1800);
                          const res = await fetch(installerEndpoint, { method: "GET", signal: ctrl.signal }).catch(() => null);
                          clearTimeout(t);
                          if (res) {
                            setInstallerProbeStatus("online");
                            setInstallerProbeDetail(`Server responded (HTTP ${res.status}). Ready to connect!`);
                          } else {
                            setInstallerProbeStatus("offline");
                            setInstallerProbeDetail(`No response on ${installerEndpoint}.`);
                          }
                        } catch {
                          setInstallerProbeStatus("offline");
                          setInstallerProbeDetail(`No response on ${installerEndpoint}.`);
                        }
                      }}
                      className="px-2.5 py-1 text-[11px] font-semibold bg-white border border-slate-300 hover:border-slate-400 text-slate-700 rounded-[5px] transition flex items-center gap-1"
                    >
                      <RefreshCw size={11} className={installerProbeStatus === "probing" ? "animate-spin" : ""} /> Test
                    </button>
                  </div>

                  {/* 1-Click Launch Command */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                        <Terminal size={12} className="text-slate-600" /> 1-Click Start Command (Terminal / Docker)
                      </label>
                      <span className="text-[10px] text-slate-400">Copy & run in terminal</span>
                    </div>
                    <div className="relative group">
                      <pre className="p-2.5 bg-slate-900 text-slate-100 rounded-[6px] font-mono text-[11px] overflow-x-auto whitespace-pre-wrap select-all pr-16 border border-slate-700">
                        {installingEngine === "zep_graphiti"
                          ? "docker run -d --name zep -p 8000:8000 -e ZEP_STORE_TYPE=postgres getzep/zep:latest"
                          : installingEngine === "cognee"
                          ? 'pip install cognee && python -c "import cognee; cognee.serve()"'
                          : "pip install letta && letta run --port 8283"}
                      </pre>
                      <button
                        type="button"
                        onClick={() => {
                          const cmd =
                            installingEngine === "zep_graphiti"
                              ? "docker run -d --name zep -p 8000:8000 -e ZEP_STORE_TYPE=postgres getzep/zep:latest"
                              : installingEngine === "cognee"
                              ? 'pip install cognee && python -c "import cognee; cognee.serve()"'
                              : "pip install letta && letta run --port 8283";
                          navigator.clipboard.writeText(cmd);
                          setInstallerCopied(true);
                          setTimeout(() => setInstallerCopied(false), 2200);
                        }}
                        className="absolute top-2 right-2 px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 rounded text-[10px] font-semibold flex items-center gap-1 transition"
                      >
                        {installerCopied ? <CheckCheck size={11} className="text-emerald-400" /> : <Copy size={11} />}
                        {installerCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>

                  {/* Config Inputs */}
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700">Server Endpoint</label>
                    <input
                      type="text"
                      value={installerEndpoint}
                      onChange={(e) => setInstallerEndpoint(e.target.value)}
                      placeholder="http://127.0.0.1:8000"
                      className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-slate-400"
                    />
                    <p className="text-[10px] text-slate-400">
                      Chat still reads the built-in vault. Endpoint is saved for the day a recall driver ships for this engine.
                    </p>
                  </div>

                  {/* Footer Actions */}
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#E5E5E5]">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setInstallingEngine(null)}
                        className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-[6px] transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const eng = engines.find((e) => e.id === installingEngine);
                          const patch: Record<string, unknown> = {
                            ...snap.settings,
                            [`${installingEngine}_endpoint`]: installerEndpoint,
                          };
                          if (installingEngine === "obsidian_khoj") {
                            patch.obsidianVault = installerEndpoint;
                          }
                          await run("save_settings", {
                            settings: patch,
                          });
                          const scanned = await run("scan_memory_engines");
                          if (installerProbeStatus === "online") {
                            setStatusBanner(`${eng?.name} answered at ${installerEndpoint}. Chat still reads the built-in vault. Zep, Cognee, and Letta are not used for recall until a driver is attached. ${scanned?.toast || ""}`.trim());
                          } else {
                            setStatusBanner(`${eng?.name} did not answer at ${installerEndpoint}. Nothing was switched on.`);
                          }
                          setInstallingEngine(null);
                        }}
                        className="px-4 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs rounded-[6px] transition flex items-center gap-1.5"
                        style={{ color: "#ffffff" }}
                      >
                        <Check size={13} className="text-white" stroke="#ffffff" />
                        <span className="text-white" style={{ color: "#ffffff" }}>Save & Test</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
        </div>
      </div>
    </div>
  );
}
