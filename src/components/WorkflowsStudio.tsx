import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  BackgroundVariant,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Plus,
  Trash2,
  Copy,
  Check,
  Sparkles,
  Brain,
  Zap,
  Globe,
  Code,
  Coins,
  ShieldAlert,
  Shuffle,
  Radio,
  Settings2,
  X,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  Bot,
  Cpu,
  FileCode2,
  LayoutGrid,
  Database,
  Sun,
  Moon,
  Hand,
  Compass,
} from "lucide-react";

import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../api";
import { useRonic } from "../store";
import type { WfNode, Workflow, BotProfile } from "../types";

// ==========================================
// 1. Step Kind Registry & Definitions
// ==========================================
export interface StepKindDef {
  id: string;
  category: "trigger" | "ai" | "action" | "logic";
  label: string;
  badge: string;
  shortDesc: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: {
    bgLight: string;
    bgDark: string;
    borderLight: string;
    borderDark: string;
    textLight: string;
    textDark: string;
    badgeLight: string;
    badgeDark: string;
    dot: string;
    accent: string;
  };
}

export const STEP_KINDS: StepKindDef[] = [
  {
    id: "webhook_trigger",
    category: "trigger",
    label: "Webhook Trigger",
    badge: "Trigger",
    shortDesc: "Listens for incoming webhooks, cron timers, or system events",
    icon: Radio,
    tone: {
      bgLight: "bg-fuchsia-50/80 hover:bg-fuchsia-100/80",
      bgDark: "bg-fuchsia-950/40 hover:bg-fuchsia-950/60",
      borderLight: "border-fuchsia-200",
      borderDark: "border-fuchsia-800/60",
      textLight: "text-fuchsia-700",
      textDark: "text-fuchsia-400",
      badgeLight: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
      badgeDark: "bg-fuchsia-950/60 text-fuchsia-300 border-fuchsia-800",
      dot: "bg-fuchsia-500",
      accent: "#d946ef",
    },
  },
  {
    id: "llm_reasoning",
    category: "ai",
    label: "Bot Reasoning & Planning",
    badge: "Reasoning",
    shortDesc: "LLM cognitive analysis, decision making, dynamic planning",
    icon: Brain,
    tone: {
      bgLight: "bg-indigo-50/80 hover:bg-indigo-100/80",
      bgDark: "bg-indigo-950/40 hover:bg-indigo-950/60",
      borderLight: "border-indigo-200",
      borderDark: "border-indigo-800/60",
      textLight: "text-indigo-700",
      textDark: "text-indigo-400",
      badgeLight: "bg-indigo-50 text-indigo-700 border-indigo-200",
      badgeDark: "bg-indigo-950/60 text-indigo-300 border-indigo-800",
      dot: "bg-indigo-500",
      accent: "#6366f1",
    },
  },
  {
    id: "bot_action",
    category: "action",
    label: "Bot Action & Execution",
    badge: "Action",
    shortDesc: "Execute agent tools, command runner, external API call",
    icon: Zap,
    tone: {
      bgLight: "bg-amber-50/80 hover:bg-amber-100/80",
      bgDark: "bg-amber-950/40 hover:bg-amber-950/60",
      borderLight: "border-amber-200",
      borderDark: "border-amber-800/60",
      textLight: "text-amber-800",
      textDark: "text-amber-400",
      badgeLight: "bg-amber-50 text-amber-800 border-amber-200",
      badgeDark: "bg-amber-950/60 text-amber-300 border-amber-800",
      dot: "bg-amber-500",
      accent: "#f59e0b",
    },
  },
  {
    id: "browser_inspect",
    category: "action",
    label: "Browser & Vision Inspect",
    badge: "Browser",
    shortDesc: "DOM inspection, page navigation, Set-of-Marks extraction",
    icon: Globe,
    tone: {
      bgLight: "bg-sky-50/80 hover:bg-sky-100/80",
      bgDark: "bg-sky-950/40 hover:bg-sky-950/60",
      borderLight: "border-sky-200",
      borderDark: "border-sky-800/60",
      textLight: "text-sky-700",
      textDark: "text-sky-400",
      badgeLight: "bg-sky-50 text-sky-700 border-sky-200",
      badgeDark: "bg-sky-950/60 text-sky-300 border-sky-800",
      dot: "bg-sky-500",
      accent: "#0ea5e9",
    },
  },
  {
    id: "code_patch",
    category: "action",
    label: "Code Patch & Refactor",
    badge: "Code",
    shortDesc: "Synthesize unified code diffs, run tests, apply patch",
    icon: Code,
    tone: {
      bgLight: "bg-emerald-50/80 hover:bg-emerald-100/80",
      bgDark: "bg-emerald-950/40 hover:bg-emerald-950/60",
      borderLight: "border-emerald-200",
      borderDark: "border-emerald-800/60",
      textLight: "text-emerald-700",
      textDark: "text-emerald-400",
      badgeLight: "bg-emerald-50 text-emerald-700 border-emerald-200",
      badgeDark: "bg-emerald-950/60 text-emerald-300 border-emerald-800",
      dot: "bg-emerald-500",
      accent: "#10b981",
    },
  },
  {
    id: "wallet_execution",
    category: "logic",
    label: "Wallet Gate (Spend Policy)",
    badge: "Wallet Gate",
    shortDesc: "USDC spend authorization, token swap, transaction signing",
    icon: Coins,
    tone: {
      bgLight: "bg-purple-50/80 hover:bg-purple-100/80",
      bgDark: "bg-purple-950/40 hover:bg-purple-950/60",
      borderLight: "border-purple-200",
      borderDark: "border-purple-800/60",
      textLight: "text-purple-700",
      textDark: "text-purple-400",
      badgeLight: "bg-purple-50 text-purple-700 border-purple-200",
      badgeDark: "bg-purple-950/60 text-purple-300 border-purple-800",
      dot: "bg-purple-500",
      accent: "#a855f7",
    },
  },
  {
    id: "approval_gate",
    category: "logic",
    label: "Human Approval Gate",
    badge: "Approval Gate",
    shortDesc: "Pauses execution until human operator reviews and approves",
    icon: ShieldAlert,
    tone: {
      bgLight: "bg-rose-50/80 hover:bg-rose-100/80",
      bgDark: "bg-rose-950/40 hover:bg-rose-950/60",
      borderLight: "border-rose-200",
      borderDark: "border-rose-800/60",
      textLight: "text-rose-700",
      textDark: "text-rose-400",
      badgeLight: "bg-rose-50 text-rose-700 border-rose-200",
      badgeDark: "bg-rose-950/60 text-rose-300 border-rose-800",
      dot: "bg-rose-500",
      accent: "#f43f5e",
    },
  },
  {
    id: "data_transform",
    category: "logic",
    label: "Data Transform & Filter",
    badge: "Transform",
    shortDesc: "JSON extraction, structure mapping, schema validation",
    icon: Shuffle,
    tone: {
      bgLight: "bg-teal-50/80 hover:bg-teal-100/80",
      bgDark: "bg-teal-950/40 hover:bg-teal-950/60",
      borderLight: "border-teal-200",
      borderDark: "border-teal-800/60",
      textLight: "text-teal-700",
      textDark: "text-teal-400",
      badgeLight: "bg-teal-50 text-teal-700 border-teal-200",
      badgeDark: "bg-teal-950/60 text-teal-300 border-teal-800",
      dot: "bg-teal-500",
      accent: "#14b8a6",
    },
  },
];

const MODEL_PRESETS = [
  { id: "auto", label: "Auto (System Agent Default)" },
  { id: "prov_gemini", label: "Gemini 2.5 Flash (Ultralight & Fast)" },
  { id: "prov_openai", label: "GPT-4o (Reasoning & Tools)" },
  { id: "prov_claude", label: "Claude 3.7 Sonnet (Hybrid Thinking)" },
  { id: "prov_deepseek", label: "DeepSeek R1 (Deep Math & Logic)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Large Context)" },
  { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku (High Throughput)" },
];

const EXPRESSION_VARIABLES = [
  { key: "{{ $json.email }}", label: "$json.email", desc: "User email address from input item" },
  { key: "{{ $json.total }}", label: "$json.total", desc: "Order/transaction amount" },
  { key: "{{ $steps.previous.output }}", label: "previous.output", desc: "Full output payload from previous step" },
  { key: "{{ $env.WORKSPACE_ROOT }}", label: "WORKSPACE_ROOT", desc: "Local workspace root path" },
  { key: "{{ $bot.handle }}", label: "bot.handle", desc: "Assigned bot profile handle" },
];

// ==========================================
// 2. Pre-Built Workflow Templates
// ==========================================
interface WorkflowTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  triggers: string[];
  nodes: WfNode[];
}

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "tmpl_sales_funnel",
    name: "Ronic OS Sales & Marketing Funnel",
    category: "Growth & Revenue",
    description: "Inbound capture, lead qualification, CRM enrichment, and automated outreach with approval check.",
    triggers: ["webhook:landing_page_lead", "schedule:daily_9am"],
    nodes: [
      {
        id: "node_1",
        name: "Awareness — Inbound capture",
        kind: "browser_inspect",
        botProfile: "",
        model: "prov_gemini",
        prompt: "Open landing page via inspect_page(url); extract Set-of-Marks control IDs and monitor traffic referrers; post raw visitor signals to squad blackboard.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_2",
        name: "Interest — Lead capture & qualification",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_gemini",
        prompt: "Open isolated PiP mini-window persist_bot_lead; validate email syntax and detect company size from domain; score intent from 1-100 based on browsing depth.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_3",
        name: "Consideration — Enrichment & scoring",
        kind: "bot_action",
        botProfile: "",
        model: "prov_openai",
        prompt: "Query memory_vault for lead intent signals; cross-reference company technographics against our 5 core value props (background automation, Code Mode token savings, local privacy).",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_4",
        name: "Intent — Outreach draft synthesis",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_claude",
        prompt: "Synthesize high-converting personalized email draft addressing recipient pain points; incorporate live benchmark metrics and a 1-click sandbox demo link.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_5",
        name: "Conversion — Operator dispatch approval",
        kind: "approval_gate",
        botProfile: "",
        model: "",
        prompt: "Hold execution until human operator reviews outreach copy, verifies email address, and approves the send.",
        status: "pending",
        latencyMs: 0,
      },
    ],
  },
  {
    id: "tmpl_code_patcher",
    name: "Autonomous Bug Triager & Code Patcher",
    category: "Engineering & QA",
    description: "Inspects stack traces, reproduces errors, generates surgical unified diffs, runs regression tests, and pauses for review.",
    triggers: ["git:on_pr_opened", "sentry:on_issue"],
    nodes: [
      {
        id: "node_1",
        name: "Triage — Stack trace analysis",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_claude",
        prompt: "Parse runtime error log and stack trace. Pinpoint failing source file, line number range, and root cause hypothesis.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_2",
        name: "Reproduction — Test case synthesis",
        kind: "bot_action",
        botProfile: "",
        model: "prov_claude",
        prompt: "Generate an isolated reproduction unit test that triggers the bug condition in the workspace test harness.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_3",
        name: "Code Patch — Unified diff generation",
        kind: "code_patch",
        botProfile: "",
        model: "prov_claude",
        prompt: "Generate a clean, minimal code patch that fixes the root cause without side-effects. Follow existing codebase conventions.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_4",
        name: "Verification — Run test suite",
        kind: "bot_action",
        botProfile: "",
        model: "prov_gemini",
        prompt: "Run workspace tests and typecheck verification. Ensure 0 regressions and that the reproduction test now passes.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_5",
        name: "PR Gate — Human code review",
        kind: "approval_gate",
        botProfile: "",
        model: "",
        prompt: "Review the code diff, test pass logs, and impact analysis before committing or opening a PR.",
        status: "pending",
        latencyMs: 0,
      },
    ],
  },
  {
    id: "tmpl_quant_sentinel",
    name: "Crypto & Quant Trading Sentinel",
    category: "Financial & Web3",
    description: "Sweeps orderbook liquidity, calculates multi-indicator alpha, enforces risk limits, and routes signed transactions.",
    triggers: ["websocket:orderbook_ticker", "schedule:every_5m"],
    nodes: [
      {
        id: "node_1",
        name: "Ingestion — Orderbook sweep",
        kind: "bot_action",
        botProfile: "",
        model: "prov_gemini",
        prompt: "Fetch top 20 bid/ask depth and 8-hour funding rates from Hyperliquid L1 WebSocket. Calculate bid-ask skew.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_2",
        name: "Alpha Signal — Momentum & volume",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_deepseek",
        prompt: "Evaluate EMA ribbon crossover and volume profile. Formulate trade hypothesis with directional conviction score (-1.0 to +1.0).",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_3",
        name: "Risk Check — VaR & sizing computation",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_deepseek",
        prompt: "Enforce Kelly Criterion and policy cap (max $25/trade). Compute exact position size, stop loss, and take profit price targets.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_4",
        name: "Capital Gate — USDC spend authorization",
        kind: "wallet_execution",
        botProfile: "",
        model: "",
        prompt: "Allocate $5.00 USDC margin from sandbox wallet. Pauses here for operator wallet policy confirmation.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_5",
        name: "Order Execution — Route limit order",
        kind: "bot_action",
        botProfile: "",
        model: "prov_gemini",
        prompt: "Dispatch signed limit order to DEX gateway. Log fill price, transaction signature, and update portfolio positions table.",
        status: "pending",
        latencyMs: 0,
      },
    ],
  },
  {
    id: "tmpl_deep_research",
    name: "Multi-Agent Deep Research Factory",
    category: "Research & Content",
    description: "Decomposes inquiries, crawls academic & web resources, validates citations, synthesizes long-form briefing.",
    triggers: ["manual:user_inquiry"],
    nodes: [
      {
        id: "node_1",
        name: "Decomposition — Formulate sub-queries",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_claude",
        prompt: "Deconstruct the primary research thesis into 4 orthogonal search vectors: technical feasibility, competitive landscape, historical precedent, and market risks.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_2",
        name: "Deep Crawl — Extract sources",
        kind: "browser_inspect",
        botProfile: "",
        model: "prov_gemini",
        prompt: "Search the web for each vector; crawl top 5 authoritative papers, documentation pages, or financial reports; extract clean markdown text and URLs.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_3",
        name: "Verification — Fact check & cross-reference",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_openai",
        prompt: "Cross-reference facts and numbers across extracted sources. Highlight any conflicting claims or unverified statements.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_4",
        name: "Synthesis — Executive briefing generation",
        kind: "llm_reasoning",
        botProfile: "",
        model: "prov_claude",
        prompt: "Author a comprehensive executive briefing with executive summary, methodology, comparative matrices, risks, and linked citations.",
        status: "pending",
        latencyMs: 0,
      },
      {
        id: "node_5",
        name: "Vault Gate — Archive to Memory Vault",
        kind: "approval_gate",
        botProfile: "",
        model: "",
        prompt: "Review document quality and approve persisting the structured briefing into Ronic OS long-term memory vault.",
        status: "pending",
        latencyMs: 0,
      },
    ],
  },
];

// ==========================================
// 3. Custom n8n Canvas Node Component
// ==========================================
interface N8nNodeData extends Record<string, unknown> {
  node: WfNode;
  stepNumber: number;
  profiles: BotProfile[];
  outputSnippet?: string;
  theme: "light" | "dark";
  onOpenInspector: (nodeId: string) => void;
  onRunSingle: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
  onReset: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
}

function N8nCanvasNode({ id, data, selected }: NodeProps<Node<N8nNodeData>>) {
  const { node, stepNumber, profiles, outputSnippet, theme, onOpenInspector, onRunSingle, onDuplicate, onReset, onDelete } = data;
  const isDark = theme === "dark";
  const kindDef = STEP_KINDS.find((k) => k.id === node.kind) ?? STEP_KINDS[1];
  const KindIcon = kindDef.icon;
  const assignedBot = profiles.find((p) => p.id === node.botProfile || p.handle === node.botProfile);

  const isConditional = node.kind === "approval_gate" || node.kind === "wallet_execution";

  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenInspector(id);
      }}
      className={`group relative min-w-[270px] max-w-[310px] rounded-2xl p-4 transition-all duration-200 border select-none ${
        isDark ? "bg-slate-900 border-slate-800 text-slate-100 shadow-xl" : "bg-white border-slate-200 text-slate-900 shadow-md"
      } ${
        selected
          ? `ring-2 ring-indigo-500 border-indigo-500 shadow-xl scale-[1.01]`
          : isDark
          ? "hover:border-slate-700 hover:shadow-2xl"
          : "hover:border-slate-400 hover:shadow-lg"
      }`}
    >
      {/* Target (Input) Handle on Left */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={`!w-3.5 !h-3.5 !rounded-full -left-2 !transition !border-2 ${
          isDark
            ? "!bg-slate-900 !border-slate-500 group-hover:!border-indigo-400"
            : "!bg-white !border-slate-400 group-hover:!border-indigo-600"
        }`}
        title="Input Data Port (INodeExecutionData)"
      />

      {/* Floating Action Bar (Top on hover/selection) */}
      <div
        className={`absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-all duration-150 flex items-center gap-1 backdrop-blur-md px-2 py-1 rounded-xl shadow-lg z-30 ${
          isDark ? "bg-slate-950/90 text-white border border-slate-800" : "bg-slate-900/90 text-white border border-slate-700"
        }`}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenInspector(id);
          }}
          className="p-1 hover:bg-white/20 rounded-md transition text-slate-200 hover:text-white"
          title="Open n8n 3-panel Inspector"
        >
          <Settings2 size={13} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRunSingle(id);
          }}
          className="p-1 hover:bg-white/20 rounded-md transition text-slate-200 hover:text-emerald-400"
          title="Test / Run this single step"
        >
          <Play size={12} className="fill-current" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate(id);
          }}
          className="p-1 hover:bg-white/20 rounded-md transition text-slate-200 hover:text-white"
          title="Duplicate step"
        >
          <Copy size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReset(id);
          }}
          className="p-1 hover:bg-white/20 rounded-md transition text-slate-200 hover:text-amber-400"
          title="Reset step to pending"
        >
          <RotateCcw size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
          className="p-1 hover:bg-rose-500/40 rounded-md transition text-rose-300 hover:text-rose-200"
          title="Delete step"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Node Header */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div
            className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 border ${
              isDark
                ? `${kindDef.tone.borderDark} ${kindDef.tone.bgDark}`
                : `${kindDef.tone.borderLight} ${kindDef.tone.bgLight}`
            }`}
          >
            <KindIcon size={14} className={isDark ? kindDef.tone.textDark : kindDef.tone.textLight} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold text-slate-400">#{stepNumber}</span>
              <span
                className={`text-[10px] font-semibold px-1.5 py-0.2 rounded-md ${
                  isDark ? kindDef.tone.badgeDark : kindDef.tone.badgeLight
                }`}
              >
                {kindDef.badge}
              </span>
            </div>
            <h4 className={`text-xs font-bold truncate leading-snug ${isDark ? "text-white" : "text-slate-900"}`}>
              {node.name}
            </h4>
          </div>
        </div>

        {/* Status Pill */}
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold rounded-full border shrink-0 ${nodeStatusTone(
            node.status,
            isDark
          )}`}
        >
          {nodeStatusIcon(node.status)}
          <span>{node.status}</span>
        </span>
      </div>

      {/* Metadata Chips: Bot & Model */}
      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap text-[10.5px]">
        <div
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono border ${
            isDark
              ? "bg-slate-950/80 border-slate-800 text-slate-300"
              : "bg-slate-50 border-slate-200 text-slate-700"
          }`}
        >
          <Bot size={11} className="text-slate-500" />
          <span className="font-semibold truncate max-w-[100px]">
            {assignedBot?.displayName || node.botProfile || "System Bot"}
          </span>
        </div>

        <div
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono border ${
            isDark
              ? "bg-slate-950/80 border-slate-800 text-slate-400"
              : "bg-slate-50 border-slate-200 text-slate-600"
          }`}
        >
          <Cpu size={10} className="text-slate-400" />
          <span className="truncate max-w-[90px]">{node.model || "auto"}</span>
        </div>

        {node.latencyMs > 0 && (
          <div className="inline-flex items-center gap-1 text-[10px] text-slate-400 font-mono ml-auto">
            <Clock size={10} />
            <span>{node.latencyMs}ms</span>
          </div>
        )}
      </div>

      {/* Prompt preview */}
      <p
        className={`mt-2 text-[11px] p-2 rounded-xl font-mono border line-clamp-2 leading-relaxed ${
          isDark
            ? "text-slate-300 bg-slate-950/60 border-slate-800/80"
            : "text-slate-600 bg-slate-50/80 border-slate-200/60"
        }`}
      >
        {node.prompt || <span className="italic text-slate-400">Double click node to configure prompt...</span>}
      </p>

      {/* Checkpoint Output Preview Snippet */}
      {outputSnippet && (
        <div
          className={`mt-2 pt-2 border-t flex items-center justify-between text-[10px] text-emerald-600 font-medium ${
            isDark ? "border-slate-800" : "border-slate-100"
          }`}
        >
          <span className="flex items-center gap-1 truncate">
            <CheckCircle2 size={11} />
            <span className="truncate">{outputSnippet.slice(0, 42)}...</span>
          </span>
          <span className="text-slate-400 shrink-0">Inspect →</span>
        </div>
      )}

      {/* Source (Output) Handles on Right */}
      {isConditional ? (
        <>
          {/* True / Approved Output Port */}
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ top: "35%" }}
            className="!w-3.5 !h-3.5 !bg-emerald-500 !border-2 !border-white !rounded-full -right-2 shadow-sm"
            title="True / Approved Output Port"
          />
          {/* False / Pause Output Port */}
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ top: "68%" }}
            className="!w-3.5 !h-3.5 !bg-rose-500 !border-2 !border-white !rounded-full -right-2 shadow-sm"
            title="False / Reject / Pause Output Port"
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className={`!w-3.5 !h-3.5 !rounded-full -right-2 shadow-sm !transition !border-2 ${
            isDark
              ? "!bg-slate-900 !border-slate-500 group-hover:!border-indigo-400"
              : "!bg-white !border-slate-400 group-hover:!border-indigo-600"
          }`}
          title="Output Data Port (out)"
        />
      )}
    </div>
  );
}

const nodeTypes = {
  n8nNode: N8nCanvasNode,
};

// -------------------------------------------------------------
// ==========================================
// 4. Main Workflows Studio Workspace
// ==========================================
export default function WorkflowsStudio() {
  const run = useRonic((s) => s.run);
  const snap = useRonic((s) => s.snap);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);

  const workflows = snap?.workflows ?? [];
  const profiles = snap?.profiles ?? [];

  // Theme State: Default to "light" (White theme) as requested, with localStorage persistence
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("ronic_wf_theme");
      return saved === "dark" ? "dark" : "light"; // Default is "light"
    } catch {
      return "light";
    }
  });

  const isDark = theme === "dark";

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try {
      localStorage.setItem("ronic_wf_theme", next);
    } catch {}
  };

  const [activeWfId, setActiveWfId] = useState<string>(workflows[0]?.id ?? "");
  const [newWfName, setNewWfName] = useState<string>("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Modals & Panels
  const [showInspectorModal, setShowInspectorModal] = useState(false);
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null);
  const [showAddNodeDrawer, setShowAddNodeDrawer] = useState(false);
  const [addNodeSearch, setAddNodeSearch] = useState("");
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [showYamlModal, setShowYamlModal] = useState(false);
  const [yamlEditorDraft, setYamlEditorDraft] = useState("");
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [trackpadScrollMode, setTrackpadScrollMode] = useState<"zoom" | "pan">("zoom");

  // Live progress state from Tauri event
  const [live, setLive] = useState<{ wfId: string; status: string; nodes: WfNode[] } | null>(null);

  // React Flow state
  const [nodes, setNodes] = useState<Node<N8nNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlistenPromise = listen<{ id: string; status: string; nodes: WfNode[] }>("ronic://wf-progress", (event) => {
      const payload = event.payload;
      if (payload?.id) {
        setLive({ wfId: payload.id, status: payload.status, nodes: payload.nodes ?? [] });
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!workflows.some((w) => w.id === activeWfId) && workflows[0]) {
      setActiveWfId(workflows[0].id);
    }
  }, [workflows, activeWfId]);

  const snapshotWf = workflows.find((w) => w.id === activeWfId) ?? workflows[0] ?? null;
  const liveForThis = live && live.wfId === snapshotWf?.id ? live : null;
  const activeWf: Workflow | null = liveForThis
    ? { ...snapshotWf!, nodes: liveForThis.nodes, currentStatus: liveForThis.status }
    : snapshotWf;

  useEffect(() => {
    if (activeWf) {
      setTitleDraft(activeWf.name);
    }
  }, [activeWf?.id, activeWf?.name]);

  const yaml = useMemo(() => (activeWf ? activeWf.yamlSource || emitYaml(activeWf, activeWf.nodes) : ""), [activeWf]);

  // Synchronize React Flow nodes & edges whenever activeWf or theme changes
  useEffect(() => {
    if (!activeWf) {
      setNodes([]);
      setEdges([]);
      return;
    }

    // Retrieve cached positions from localStorage
    let savedPositions: Record<string, { x: number; y: number }> = {};
    try {
      const raw = localStorage.getItem(`ronic_wf_positions_${activeWf.id}`);
      if (raw) savedPositions = JSON.parse(raw);
    } catch {}

    const flowNodes: Node<N8nNodeData>[] = activeWf.nodes.map((n, idx) => {
      const isBranch = n.kind === "approval_gate" || n.kind === "wallet_execution";
      const defaultPos = {
        x: 80 + idx * 340,
        y: isBranch ? 180 + (idx % 2 === 0 ? 0 : 120) : 180,
      };
      const pos = savedPositions[n.id] || defaultPos;

      return {
        id: n.id,
        type: "n8nNode",
        position: pos,
        data: {
          node: n,
          stepNumber: idx + 1,
          profiles,
          theme,
          outputSnippet: activeWf.checkpoint?.[n.id],
          onOpenInspector: (nodeId: string) => {
            setInspectorNodeId(nodeId);
            setShowInspectorModal(true);
          },
          onRunSingle: (nodeId: string) => {
            handleRunSingleStep(nodeId);
          },
          onDuplicate: (nodeId: string) => {
            handleDuplicateNode(nodeId);
          },
          onReset: (nodeId: string) => {
            handleResetStep(nodeId);
          },
          onDelete: (nodeId: string) => {
            handleDeleteNode(nodeId);
          },
        },
      };
    });

    // Generate or restore edges
    let savedEdges: Edge[] = [];
    try {
      const rawEdges = localStorage.getItem(`ronic_wf_edges_${activeWf.id}`);
      if (rawEdges) savedEdges = JSON.parse(rawEdges);
    } catch {}

    let flowEdges: Edge[] = [];
    if (savedEdges && savedEdges.length > 0) {
      const nodeIds = new Set(activeWf.nodes.map((n) => n.id));
      flowEdges = savedEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    }

    // If no saved edges or node count changed, generate sequential n8n DAG connections
    if (flowEdges.length === 0 && activeWf.nodes.length > 1) {
      flowEdges = activeWf.nodes.slice(0, -1).map((n, idx) => {
        const nextNode = activeWf.nodes[idx + 1];
        const isConditional = n.kind === "approval_gate" || n.kind === "wallet_execution";
        const strokeColor = isConditional ? "#10b981" : isDark ? "#64748b" : "#94a3b8";
        return {
          id: `e_${n.id}_${nextNode.id}`,
          source: n.id,
          sourceHandle: isConditional ? "true" : "out",
          target: nextNode.id,
          targetHandle: "in",
          animated: activeWf.currentStatus === "running" && n.status === "running",
          style: { stroke: strokeColor, strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: strokeColor,
          },
        };
      });
    }

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [activeWf?.id, activeWf?.nodes, activeWf?.checkpoint, activeWf?.currentStatus, profiles, theme]);

  // Handle Dragging & Position Updates
  const onNodesChange: OnNodesChange<Node<N8nNodeData>> = useCallback(
    (changes) => {
      setNodes((nds) => {
        const nextNodes = applyNodeChanges(changes, nds);
        if (activeWf) {
          const positions: Record<string, { x: number; y: number }> = {};
          nextNodes.forEach((n) => {
            positions[n.id] = n.position;
          });
          try {
            localStorage.setItem(`ronic_wf_positions_${activeWf.id}`, JSON.stringify(positions));
          } catch {}
        }
        return nextNodes;
      });
    },
    [activeWf]
  );

  // Handle Edge Changes (deletion, selection)
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      setEdges((eds) => {
        const nextEdges = applyEdgeChanges(changes, eds);
        if (activeWf) {
          try {
            localStorage.setItem(`ronic_wf_edges_${activeWf.id}`, JSON.stringify(nextEdges));
          } catch {}
        }
        return nextEdges;
      });
    },
    [activeWf]
  );

  // Handle Drag-to-Connect Handles
  const onConnect: OnConnect = useCallback(
    (connection) => {
      setEdges((eds) => {
        const nextEdges = addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: "#6366f1", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#6366f1" },
          },
          eds
        );
        if (activeWf) {
          try {
            localStorage.setItem(`ronic_wf_edges_${activeWf.id}`, JSON.stringify(nextEdges));
          } catch {}
        }
        return nextEdges;
      });
    },
    [activeWf]
  );

  // Persist workflow changes back to Ronic OS backend
  const persist = (wf: Workflow, updatedNodes: WfNode[], nameOverride?: string) => {
    const name = nameOverride ?? wf.name;
    const yamlStr = emitYaml({ ...wf, name }, updatedNodes);
    void run("update_workflow", {
      patch: {
        id: wf.id,
        name,
        nodes: updatedNodes,
        yamlSource: yamlStr,
      },
    });
  };

  // Execution Statistics
  const stats = useMemo(() => {
    if (!activeWf) return { total: 0, done: 0, percent: 0, totalLatency: 0 };
    const total = activeWf.nodes.length;
    let done = 0;
    let totalLatency = 0;
    for (const n of activeWf.nodes) {
      if (n.status === "done") done += 1;
      totalLatency += n.latencyMs || 0;
    }
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, done, percent, totalLatency };
  }, [activeWf]);

  // Node Actions
  const handleAddNodeToCanvas = (kind: string) => {
    if (!snapshotWf) return;
    const currentNodes = liveForThis?.nodes ?? snapshotWf.nodes;
    const id = `node_${Math.random().toString(36).slice(2, 7)}${Date.now().toString(36).slice(-3)}`;
    const kindDef = STEP_KINDS.find((k) => k.id === kind);
    const newNode: WfNode = {
      id,
      name: `${currentNodes.length + 1}. ${kindDef?.label ?? kind.replace(/_/g, " ")}`,
      kind,
      botProfile: "",
      model: "auto",
      prompt: "",
      status: "pending",
      latencyMs: 0,
    };

    // Auto place next to last node
    const lastNode = nodes[nodes.length - 1];
    const newPos = lastNode
      ? { x: lastNode.position.x + 350, y: lastNode.position.y }
      : { x: 100, y: 180 };

    try {
      const positionsRaw = localStorage.getItem(`ronic_wf_positions_${snapshotWf.id}`) || "{}";
      const positions = JSON.parse(positionsRaw);
      positions[id] = newPos;
      localStorage.setItem(`ronic_wf_positions_${snapshotWf.id}`, JSON.stringify(positions));
    } catch {}

    setShowAddNodeDrawer(false);
    setLive(null);
    persist(snapshotWf, [...currentNodes, newNode]);
    setInspectorNodeId(id);
    setShowInspectorModal(true);
  };

  const handleUpdateNodeFromInspector = (nodeId: string, patch: Partial<WfNode>) => {
    if (!snapshotWf) return;
    const currentNodes = liveForThis?.nodes ?? snapshotWf.nodes;
    const nextNodes = currentNodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
    persist(snapshotWf, nextNodes);
  };

  const handleDeleteNode = (nodeId: string) => {
    if (!snapshotWf) return;
    const currentNodes = liveForThis?.nodes ?? snapshotWf.nodes;
    if (currentNodes.length <= 1) return;
    const nextNodes = currentNodes.filter((n) => n.id !== nodeId);
    setLive(null);
    if (inspectorNodeId === nodeId) {
      setShowInspectorModal(false);
    }
    persist(snapshotWf, nextNodes);
  };

  const handleDuplicateNode = (nodeId: string) => {
    if (!snapshotWf) return;
    const currentNodes = liveForThis?.nodes ?? snapshotWf.nodes;
    const source = currentNodes.find((n) => n.id === nodeId);
    if (!source) return;

    const newId = `node_${Math.random().toString(36).slice(2, 7)}${Date.now().toString(36).slice(-3)}`;
    const duplicate: WfNode = {
      ...source,
      id: newId,
      name: `${source.name} (Copy)`,
      status: "pending",
      latencyMs: 0,
    };

    const sourceFlow = nodes.find((n) => n.id === nodeId);
    const newPos = sourceFlow
      ? { x: sourceFlow.position.x + 40, y: sourceFlow.position.y + 120 }
      : { x: 200, y: 200 };

    try {
      const positionsRaw = localStorage.getItem(`ronic_wf_positions_${snapshotWf.id}`) || "{}";
      const positions = JSON.parse(positionsRaw);
      positions[newId] = newPos;
      localStorage.setItem(`ronic_wf_positions_${snapshotWf.id}`, JSON.stringify(positions));
    } catch {}

    setLive(null);
    persist(snapshotWf, [...currentNodes, duplicate]);
  };

  const handleResetStep = (nodeId: string) => {
    if (!snapshotWf) return;
    const currentNodes = liveForThis?.nodes ?? snapshotWf.nodes;
    const nextNodes = currentNodes.map((n) => (n.id === nodeId ? { ...n, status: "pending" as const, latencyMs: 0 } : n));
    setLive(null);
    persist(snapshotWf, nextNodes);
  };

  const handleRunSingleStep = async (nodeId: string) => {
    if (!snapshotWf) return;
    const currentNodes = liveForThis?.nodes ?? snapshotWf.nodes;
    const node = currentNodes.find((n) => n.id === nodeId);
    if (!node) return;

    const nextNodes = currentNodes.map((n) => (n.id === nodeId ? { ...n, status: "running" as const } : n));
    setLive({ wfId: snapshotWf.id, status: "running", nodes: nextNodes });

    setTimeout(() => {
      const doneNodes = currentNodes.map((n) =>
        n.id === nodeId ? { ...n, status: "done" as const, latencyMs: Math.floor(Math.random() * 300 + 150) } : n
      );
      const checkpoint = { ...(snapshotWf.checkpoint || {}) };
      checkpoint[nodeId] = `Test output for step "${node.name}" (${node.kind}): evaluated successfully with ${node.model || "default agent engine"}.`;

      void run("update_workflow", {
        patch: {
          id: snapshotWf.id,
          nodes: doneNodes,
          checkpoint,
        },
      });
      setLive(null);
    }, 700);
  };

  const handleAutoLayoutDAG = () => {
    if (!activeWf) return;
    const updatedPositions: Record<string, { x: number; y: number }> = {};
    activeWf.nodes.forEach((n, idx) => {
      const isBranch = n.kind === "approval_gate" || n.kind === "wallet_execution";
      updatedPositions[n.id] = {
        x: 80 + idx * 360,
        y: isBranch ? 180 + (idx % 2 === 0 ? 0 : 140) : 180,
      };
    });
    try {
      localStorage.setItem(`ronic_wf_positions_${activeWf.id}`, JSON.stringify(updatedPositions));
    } catch {}

    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        position: updatedPositions[n.id] || n.position,
      }))
    );
  };

  const handleCreateWorkflow = () => {
    const name = newWfName.trim() || "Untitled workflow";
    void run("create_workflow", { name }).then((res) => {
      const created = res?.snapshot.workflows.find((w) => w.name === name) ?? res?.snapshot.workflows[0];
      if (created) {
        setActiveWfId(created.id);
      }
      setNewWfName("");
    });
  };

  const handleCreateFromTemplate = async (tmpl: WorkflowTemplate) => {
    const res = await run("create_workflow", { name: tmpl.name });
    const created = res?.snapshot.workflows.find((w) => w.name === tmpl.name) ?? res?.snapshot.workflows[0];
    if (created) {
      const updatedNodes = tmpl.nodes.map((n, idx) => ({
        ...n,
        id: `node_${idx + 1}`,
      }));
      const generatedYaml = emitYaml({ ...created, name: tmpl.name, triggers: tmpl.triggers }, updatedNodes);
      await run("update_workflow", {
        patch: {
          id: created.id,
          name: tmpl.name,
          nodes: updatedNodes,
          yamlSource: generatedYaml,
        },
      });
      setActiveWfId(created.id);
      setShowTemplatesModal(false);
    }
  };

  const handleDeleteWorkflow = (wfId: string) => {
    void run("delete_workflow", { id: wfId }).then(() => {
      setConfirmDeleteId(null);
      const remaining = workflows.filter((w) => w.id !== wfId);
      if (remaining[0]) {
        setActiveWfId(remaining[0].id);
      }
    });
  };

  const inspectedNode = useMemo(() => {
    return activeWf?.nodes.find((n) => n.id === inspectorNodeId) ?? null;
  }, [activeWf, inspectorNodeId]);

  const inspectedPreviousNode = useMemo(() => {
    if (!activeWf || !inspectedNode) return null;
    const idx = activeWf.nodes.findIndex((n) => n.id === inspectedNode.id);
    return idx > 0 ? activeWf.nodes[idx - 1] : null;
  }, [activeWf, inspectedNode]);

  return (
    <div
      className={`flex-1 h-full flex flex-col overflow-hidden font-sans select-none transition-colors duration-200 ${
        isDark ? "bg-[#0F172A] text-slate-100" : "bg-[#F8FAFC] text-slate-900"
      }`}
    >
      {/* ========================================================= */}
      {/* 1. TOP HEADER & WORKFLOW CONTROL TOOLBAR                  */}
      {/* ========================================================= */}
      <header
        className={`px-6 py-3 flex flex-wrap items-center justify-between gap-4 shrink-0 z-20 shadow-xs border-b ${
          isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200"
        }`}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => go("chat")}
            className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition cursor-pointer shadow-xs active:scale-98 border ${
              isDark
                ? "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200"
                : "bg-white hover:bg-slate-100 border-slate-200 text-slate-700 hover:text-slate-900"
            }`}
            title="Back to Chat (Alt+Left)"
          >
            <ArrowLeft size={13} />
            <span>Chat</span>
          </button>

          <div className="flex items-center gap-2">
            {isEditingTitle ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && snapshotWf) {
                      persist(snapshotWf, activeWf?.nodes || [], titleDraft.trim());
                      setIsEditingTitle(false);
                    }
                    if (e.key === "Escape") setIsEditingTitle(false);
                  }}
                  autoFocus
                  className={`text-base font-bold px-2 py-0.5 border border-indigo-500 rounded outline-none ${
                    isDark ? "text-white bg-slate-800" : "text-slate-900 bg-indigo-50/40"
                  }`}
                />
                <button
                  onClick={() => {
                    if (snapshotWf) persist(snapshotWf, activeWf?.nodes || [], titleDraft.trim());
                    setIsEditingTitle(false);
                  }}
                  className="p-1 text-emerald-500 hover:bg-emerald-50 rounded cursor-pointer"
                >
                  <Check size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2.5">
                <h1
                  onClick={() => setIsEditingTitle(true)}
                  className={`text-base font-bold hover:text-indigo-600 transition cursor-pointer flex items-center gap-1.5 ${
                    isDark ? "text-white" : "text-slate-900"
                  }`}
                  title="Click to rename workflow"
                >
                  {activeWf?.name ?? "Workflows Studio"}
                </h1>
                {activeWf && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-mono font-semibold rounded-full border ${statusTone(
                      activeWf.currentStatus,
                      isDark
                    )}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot(activeWf.currentStatus)}`} />
                    {activeWf.currentStatus}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons & Theme Switcher */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Theme Toggle (Light / Dark Switcher) */}
          <button
            onClick={toggleTheme}
            className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition cursor-pointer shadow-2xs ${
              isDark
                ? "bg-slate-800 hover:bg-slate-700 text-amber-300 border-slate-700"
                : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
            }`}
            title={`Switch to ${isDark ? "White (Light)" : "Dark"} theme`}
          >
            {isDark ? <Sun size={13} className="text-amber-400" /> : <Moon size={13} className="text-indigo-600" />}
            <span>{isDark ? "Light mode" : "Dark mode"}</span>
          </button>

          {/* Add Node Button */}
          <button
            onClick={() => setShowAddNodeDrawer(true)}
            className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg flex items-center gap-1.5 transition cursor-pointer shadow-xs active:scale-98"
            title="Open n8n Node Library"
          >
            <Plus size={14} />
            <span>Add Node</span>
          </button>

          {/* Auto Layout (DAG Beautify) */}
          <button
            onClick={handleAutoLayoutDAG}
            className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition cursor-pointer ${
              isDark
                ? "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
                : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
            }`}
            title="Auto-organize graph layout"
          >
            <LayoutGrid size={13} />
            <span>Auto Layout</span>
          </button>

          {/* Templates Gallery */}
          <button
            onClick={() => setShowTemplatesModal(true)}
            className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition cursor-pointer ${
              isDark
                ? "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
                : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
            }`}
            title="Browse workflow templates"
          >
            <Sparkles size={13} className="text-amber-500" />
            <span>Templates</span>
          </button>

          <div className={`h-4 w-px mx-1 ${isDark ? "bg-slate-800" : "bg-slate-200"}`} />

          {/* Execution Controls */}
          <button
            onClick={() => {
              setLive(null);
              if (snapshotWf) void run("run_workflow", { id: snapshotWf.id });
            }}
            disabled={!snapshotWf || busy || activeWf?.currentStatus === "running"}
            className="px-3.5 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 shadow-xs active:scale-98"
            title="Execute entire workflow graph"
          >
            <Play size={12} className={activeWf?.currentStatus === "running" ? "animate-spin" : "fill-current"} />
            <span>{activeWf?.currentStatus === "running" ? "Running..." : "Test workflow"}</span>
          </button>

          <button
            onClick={() => snapshotWf && void run("pause_workflow", { id: snapshotWf.id })}
            disabled={!snapshotWf || busy || activeWf?.currentStatus !== "running"}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 ${
              isDark
                ? "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
                : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
            }`}
            title="Pause execution"
          >
            <Pause size={12} />
            <span>Pause</span>
          </button>

          <button
            onClick={() => {
              setLive(null);
              if (snapshotWf) void run("resume_workflow", { id: snapshotWf.id });
            }}
            disabled={!snapshotWf || busy || !activeWf?.currentStatus.includes("paused")}
            className="px-3 py-1.5 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 shadow-xs"
            title="Resume paused approval gate"
          >
            <Play size={12} className="fill-current" />
            <span>Resume</span>
          </button>

          {/* YAML Spec */}
          <button
            onClick={() => {
              setYamlEditorDraft(yaml);
              setShowYamlModal(true);
            }}
            disabled={!activeWf}
            className={`p-1.5 rounded-lg border transition cursor-pointer ${
              isDark
                ? "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
                : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
            }`}
            title="View or edit YAML graph spec"
          >
            <FileCode2 size={14} />
          </button>

          {/* Delete Workflow */}
          {activeWf && (
            <button
              onClick={() => setConfirmDeleteId(activeWf.id)}
              className={`p-1.5 rounded-lg transition cursor-pointer ${
                isDark
                  ? "text-slate-400 hover:text-rose-400 hover:bg-rose-950/40"
                  : "text-slate-400 hover:text-rose-600 hover:bg-rose-50"
              }`}
              title="Delete this workflow"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </header>

      {/* ========================================================= */}
      {/* 2. WORKFLOW TABS & EXECUTION METRICS                      */}
      {/* ========================================================= */}
      <div
        className={`px-6 py-2 flex flex-wrap items-center justify-between gap-3 shrink-0 z-10 border-b ${
          isDark ? "bg-slate-900/80 border-slate-800 backdrop-blur-sm" : "bg-slate-50/90 border-slate-200"
        }`}
      >
        <div className="flex items-center gap-2 overflow-x-auto max-w-2xl py-0.5">
          {workflows.map((wf) => {
            const isActive = wf.id === activeWf?.id;
            return (
              <button
                key={wf.id}
                onClick={() => setActiveWfId(wf.id)}
                className={`px-3 py-1 text-xs font-semibold rounded-lg transition cursor-pointer whitespace-nowrap flex items-center gap-1.5 ${
                  isActive
                    ? isDark
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "bg-slate-900 text-white shadow-xs"
                    : isDark
                    ? "bg-slate-800/80 text-slate-400 hover:text-white hover:bg-slate-700"
                    : "bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-emerald-400" : "bg-slate-400"}`} />
                <span className="max-w-[140px] truncate">{wf.name}</span>
                <span className="text-[10px] opacity-75 font-mono">({wf.nodes.length})</span>
              </button>
            );
          })}

          {/* Create Blank Inline */}
          <div className="flex items-center gap-1">
            <input
              value={newWfName}
              onChange={(e) => setNewWfName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateWorkflow();
              }}
              placeholder="New workflow name..."
              className={`w-32 px-2.5 py-1 text-xs rounded-md outline-none border focus:border-indigo-500 ${
                isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-white border-slate-200 text-slate-900"
              }`}
            />
            <button
              onClick={handleCreateWorkflow}
              className={`p-1 rounded-md cursor-pointer border ${
                isDark
                  ? "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
                  : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
              }`}
              title="Create blank workflow"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        {/* Live Metrics */}
        {activeWf && (
          <div className="flex items-center gap-4 text-xs font-mono text-slate-500">
            <div className="flex items-center gap-2">
              <span className="font-sans text-[11px] text-slate-400">Execution:</span>
              <div
                className={`w-20 h-2 rounded-full overflow-hidden border ${
                  isDark ? "bg-slate-800 border-slate-700" : "bg-slate-200 border-slate-300"
                }`}
              >
                <div
                  className={`h-full transition-all duration-300 ${
                    stats.percent === 100 ? "bg-emerald-500" : "bg-indigo-600"
                  }`}
                  style={{ width: `${stats.percent}%` }}
                />
              </div>
              <span className={isDark ? "text-slate-200" : "text-slate-800 font-semibold"}>
                {stats.done}/{stats.total} ({stats.percent}%)
              </span>
            </div>

            {stats.totalLatency > 0 && (
              <div className="flex items-center gap-1 text-[11px] text-slate-500">
                <Clock size={11} />
                <span>{stats.totalLatency}ms</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ========================================================= */}
      {/* 3. N8N REACT FLOW CANVAS (WITH TRACKPAD/TOUCHPINCH ZOOM)  */}
      {/* ========================================================= */}
      <div className={`flex-1 w-full h-full relative overflow-hidden ${isDark ? "bg-[#020617]" : "bg-[#F8FAFC]"}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={3}
          zoomOnScroll={trackpadScrollMode === "zoom"}
          zoomOnPinch={true}
          panOnScroll={trackpadScrollMode === "pan"}
          panOnDrag={true}
          preventScrolling={true}
          zoomActivationKeyCode={null}
          zoomOnDoubleClick={false}
          className={isDark ? "bg-[#020617]" : "bg-[#F8FAFC]"}
        >
          {/* n8n-style Dot Grid with Theme Support */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            color={isDark ? "#334155" : "#CBD5E1"}
          />

          {/* Canvas Controls */}
          <Controls
            className={
              isDark
                ? "!bg-slate-900 !border !border-slate-800 !rounded-xl !shadow-xl !fill-white [&>button]:!bg-slate-900 [&>button]:!border-slate-800 [&>button:hover]:!bg-slate-800"
                : "!bg-white !border !border-slate-200 !rounded-xl !shadow-md !fill-slate-700 [&>button]:!bg-white [&>button]:!border-slate-200 [&>button:hover]:!bg-slate-100 [&>button>svg]:!fill-slate-700"
            }
          />

          {/* Minimap */}
          <MiniMap
            zoomable
            pannable
            nodeColor="#6366f1"
            maskColor={isDark ? "rgba(15, 23, 42, 0.75)" : "rgba(241, 245, 249, 0.7)"}
            className={
              isDark
                ? "!bg-slate-900 !border !border-slate-800 !rounded-xl !shadow-xl"
                : "!bg-white !border !border-slate-200 !rounded-xl !shadow-md"
            }
          />

          {/* Canvas Bottom-Left Gesture & Zoom Guide */}
          <Panel position="bottom-left" className="m-4">
            <div
              className={`px-3 py-1.5 rounded-xl border text-[11px] backdrop-blur-md flex items-center gap-2.5 shadow-sm ${
                isDark
                  ? "bg-slate-900/90 border-slate-800 text-slate-400"
                  : "bg-white/90 border-slate-200 text-slate-600"
              }`}
            >
              <Compass size={13} className="text-indigo-500 shrink-0" />
              <span>Trackpad: Pinch or 2-finger scroll to zoom • Drag canvas to pan</span>
              <button
                type="button"
                onClick={() => setTrackpadScrollMode((prev) => (prev === "zoom" ? "pan" : "zoom"))}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition cursor-pointer border ${
                  trackpadScrollMode === "zoom"
                    ? "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800"
                    : "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
                }`}
                title="Toggle trackpad 2-finger scroll between Zoom and Pan (pinch always zooms)"
              >
                Scroll: {trackpadScrollMode}
              </button>
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {/* ========================================================= */}
      {/* 4. N8N SIGNATURE 3-PANEL INSPECTOR MODAL                  */}
      {/* ========================================================= */}
      {showInspectorModal && inspectedNode && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-6">
          <div
            className={`border rounded-3xl w-full max-w-6xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 ${
              isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200 text-slate-900"
            }`}
          >
            {/* Modal Header */}
            <div
              className={`px-6 py-4 border-b flex items-center justify-between ${
                isDark ? "bg-slate-900/80 border-slate-800" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`p-2 rounded-xl border ${
                    isDark
                      ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                      : "bg-indigo-50 text-indigo-700 border-indigo-200"
                  }`}
                >
                  <Settings2 size={18} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-400">Node Configuration</span>
                    <span className="text-xs text-slate-500">•</span>
                    <span className="text-xs font-mono text-indigo-600 font-semibold">{inspectedNode.id}</span>
                  </div>
                  <h3 className={`text-base font-bold ${isDark ? "text-white" : "text-slate-900"}`}>
                    {inspectedNode.name}
                  </h3>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleRunSingleStep(inspectedNode.id)}
                  className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5 cursor-pointer shadow-xs active:scale-98"
                  title="Test run this single step"
                >
                  <Play size={12} className="fill-current" />
                  <span>Test Step</span>
                </button>

                <button
                  onClick={() => setShowInspectorModal(false)}
                  className={`p-1.5 rounded-lg cursor-pointer ${
                    isDark ? "text-slate-400 hover:text-white hover:bg-slate-800" : "text-slate-500 hover:text-slate-900 hover:bg-slate-200"
                  }`}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* 3-Column n8n Inspector Body */}
            <div
              className={`flex-1 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x overflow-hidden ${
                isDark ? "divide-slate-800" : "divide-slate-200"
              }`}
            >
              {/* COLUMN 1: INPUT DATA & PAIRED ITEM LINEAGE (LEFT) */}
              <div
                className={`lg:col-span-4 p-5 flex flex-col overflow-y-auto space-y-3 ${
                  isDark ? "bg-slate-950/40" : "bg-slate-50/70"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <Database size={13} className="text-sky-500" />
                    <span>Input Data (INodeExecutionData)</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">Lineage Trace</span>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Incoming data emitted by preceding node in the DAG graph. Click any expression variable below to insert
                  into prompt instructions.
                </p>

                {/* Variable Expression Insertion Chips */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Click to Insert Expression:
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {EXPRESSION_VARIABLES.map((exp) => (
                      <button
                        key={exp.key}
                        type="button"
                        onClick={() => {
                          const currentPrompt = inspectedNode.prompt || "";
                          handleUpdateNodeFromInspector(inspectedNode.id, {
                            prompt: currentPrompt ? `${currentPrompt} ${exp.key}` : exp.key,
                          });
                        }}
                        className={`px-2.5 py-1 text-left rounded-lg border transition cursor-pointer flex items-center justify-between group ${
                          isDark
                            ? "bg-slate-900 hover:bg-indigo-950/50 border-slate-800 hover:border-indigo-500/50"
                            : "bg-white hover:bg-indigo-50/80 border-slate-200 hover:border-indigo-300"
                        }`}
                      >
                        <code className="text-[11px] font-mono text-indigo-600 font-semibold">{exp.label}</code>
                        <span className="text-[10px] text-slate-400 group-hover:text-slate-600">{exp.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Simulated Input Payload Preview */}
                <div className="mt-3 flex-1 flex flex-col">
                  <span className="text-[10.5px] font-mono text-slate-400 mb-1">
                    Incoming Payload {inspectedPreviousNode ? `(from ${inspectedPreviousNode.name})` : "(Trigger)"}:
                  </span>
                  <pre
                    className={`p-3 rounded-xl font-mono text-[11px] overflow-x-auto max-h-56 leading-relaxed border ${
                      isDark
                        ? "bg-slate-950 border-slate-800 text-sky-300"
                        : "bg-white border-slate-200 text-slate-800"
                    }`}
                  >
                    {JSON.stringify(
                      [
                        {
                          json: {
                            id: inspectedNode.id,
                            status: inspectedNode.status,
                            model: inspectedNode.model || "auto",
                            prompt: inspectedNode.prompt || "null",
                          },
                          pairedItem: { item: 0 },
                        },
                      ],
                      null,
                      2
                    )}
                  </pre>
                </div>
              </div>

              {/* COLUMN 2: NODE SETTINGS & CONFIGURATION (CENTER) */}
              <div className={`lg:col-span-4 p-5 flex flex-col overflow-y-auto space-y-4 ${isDark ? "bg-slate-900" : "bg-white"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <Settings2 size={13} className="text-indigo-600" />
                    <span>Node Parameters</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">Settings</span>
                </div>

                {/* Step Title */}
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-500 block">Step Title</label>
                  <input
                    value={inspectedNode.name}
                    onChange={(e) => handleUpdateNodeFromInspector(inspectedNode.id, { name: e.target.value })}
                    className={`w-full px-3 py-1.5 text-xs rounded-xl outline-none border focus:border-indigo-500 ${
                      isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-slate-50 border-slate-200 text-slate-900"
                    }`}
                  />
                </div>

                {/* Step Kind Selector */}
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-500 block">Step Type</label>
                  <select
                    value={inspectedNode.kind}
                    onChange={(e) => handleUpdateNodeFromInspector(inspectedNode.id, { kind: e.target.value })}
                    className={`w-full px-3 py-1.5 text-xs rounded-xl outline-none border focus:border-indigo-500 cursor-pointer ${
                      isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-slate-50 border-slate-200 text-slate-900"
                    }`}
                  >
                    {STEP_KINDS.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label} ({k.badge})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Assigned Bot Fleet Selector */}
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-500 block flex items-center justify-between">
                    <span>Assigned Bot Fleet Member</span>
                    <span className="text-[10px] text-slate-400 font-normal">Executor</span>
                  </label>
                  <select
                    value={inspectedNode.botProfile}
                    onChange={(e) => handleUpdateNodeFromInspector(inspectedNode.id, { botProfile: e.target.value })}
                    className={`w-full px-3 py-1.5 text-xs rounded-xl outline-none border focus:border-indigo-500 cursor-pointer ${
                      isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-slate-50 border-slate-200 text-slate-900"
                    }`}
                  >
                    <option value="">Default System Core</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.handle || p.id}>
                        {p.displayName || p.handle} {p.role ? `— ${p.role}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {/* AI Model Selector */}
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-500 block">Model Provider Override</label>
                  <select
                    value={inspectedNode.model}
                    onChange={(e) => handleUpdateNodeFromInspector(inspectedNode.id, { model: e.target.value })}
                    className={`w-full px-3 py-1.5 text-xs rounded-xl outline-none border focus:border-indigo-500 cursor-pointer ${
                      isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-slate-50 border-slate-200 text-slate-900"
                    }`}
                  >
                    {MODEL_PRESETS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Step Prompt Editor */}
                <div className="space-y-1 flex-1 flex flex-col">
                  <label className="text-[11px] font-semibold text-slate-500 block">Prompt / Directive</label>
                  <textarea
                    rows={4}
                    value={inspectedNode.prompt}
                    onChange={(e) => handleUpdateNodeFromInspector(inspectedNode.id, { prompt: e.target.value })}
                    placeholder="Describe the instructions or dynamic expression to evaluate..."
                    className={`w-full p-3 text-xs rounded-xl font-mono outline-none border focus:border-indigo-500 leading-relaxed resize-none flex-1 min-h-[100px] ${
                      isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-slate-50 border-slate-200 text-slate-900"
                    }`}
                  />
                </div>
              </div>

              {/* COLUMN 3: OUTPUT PREVIEW & TEST RESULTS (RIGHT) */}
              <div
                className={`lg:col-span-4 p-5 flex flex-col overflow-y-auto space-y-3 ${
                  isDark ? "bg-slate-950/40" : "bg-slate-50/70"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <CheckCircle2 size={13} className="text-emerald-500" />
                    <span>Output Preview & Response</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">Results</span>
                </div>

                <div
                  className={`flex-1 rounded-xl p-3 font-mono text-xs overflow-y-auto min-h-[220px] border ${
                    isDark
                      ? "bg-slate-950 border-slate-800 text-slate-200"
                      : "bg-white border-slate-200 text-slate-900 shadow-2xs"
                  }`}
                >
                  {activeWf?.checkpoint?.[inspectedNode.id] ? (
                    <pre className="whitespace-pre-wrap leading-relaxed select-text text-emerald-600 font-semibold">
                      {activeWf.checkpoint[inspectedNode.id]}
                    </pre>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-2 py-10">
                      <Clock size={24} className="text-slate-300" />
                      <p className="text-xs">No output recorded yet.</p>
                      <button
                        onClick={() => handleRunSingleStep(inspectedNode.id)}
                        className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg cursor-pointer shadow-xs"
                      >
                        Run Test Now
                      </button>
                    </div>
                  )}
                </div>

                {inspectedNode.latencyMs > 0 && (
                  <div className="text-[11px] font-mono text-slate-500 flex items-center gap-1.5">
                    <Clock size={12} />
                    <span>Recorded Latency: {inspectedNode.latencyMs}ms</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 5. N8N NODE LIBRARY PALETTE DRAWER                        */}
      {/* ========================================================= */}
      {showAddNodeDrawer && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-end">
          <div
            className={`border-l w-full max-w-md h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-200 ${
              isDark ? "bg-slate-900 border-slate-800 text-white" : "bg-white border-slate-200 text-slate-900"
            }`}
          >
            {/* Drawer Header */}
            <div className={`p-5 border-b flex items-center justify-between ${isDark ? "border-slate-800" : "border-slate-200"}`}>
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-600">
                  <Plus size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold">Add Node to Graph</h3>
                  <p className="text-xs text-slate-400">Select an integration trigger, reasoning step, or action.</p>
                </div>
              </div>
              <button
                onClick={() => setShowAddNodeDrawer(false)}
                className={`p-1 rounded-lg cursor-pointer ${
                  isDark ? "text-slate-400 hover:text-white hover:bg-slate-800" : "text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                }`}
              >
                <X size={16} />
              </button>
            </div>

            {/* Search Filter */}
            <div className={`p-3 border-b ${isDark ? "border-slate-800" : "border-slate-200"}`}>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={addNodeSearch}
                  onChange={(e) => setAddNodeSearch(e.target.value)}
                  placeholder="Filter nodes by name or category..."
                  className={`w-full pl-8 pr-3 py-1.5 text-xs rounded-xl outline-none border focus:border-indigo-500 ${
                    isDark ? "bg-slate-950 border-slate-800 text-white" : "bg-slate-50 border-slate-200 text-slate-900"
                  }`}
                />
              </div>
            </div>

            {/* Node Categories List */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {(["trigger", "ai", "action", "logic"] as const).map((cat) => {
                const categoryNodes = STEP_KINDS.filter(
                  (k) =>
                    k.category === cat &&
                    (addNodeSearch.trim() === "" ||
                      k.label.toLowerCase().includes(addNodeSearch.toLowerCase()) ||
                      k.shortDesc.toLowerCase().includes(addNodeSearch.toLowerCase()))
                );

                if (categoryNodes.length === 0) return null;

                const catLabels: Record<string, string> = {
                  trigger: "⚡ 1. Event Triggers",
                  ai: "🧠 2. AI & Cognitive Reasoning",
                  action: "🛠️ 3. Automated Actions & Tools",
                  logic: "🔀 4. Logic & Flow Control",
                };

                return (
                  <div key={cat} className="space-y-2">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">{catLabels[cat]}</h4>
                    <div className="grid grid-cols-1 gap-2">
                      {categoryNodes.map((k) => {
                        const Icon = k.icon;
                        return (
                          <div
                            key={k.id}
                            onClick={() => handleAddNodeToCanvas(k.id)}
                            className={`p-3 rounded-xl transition cursor-pointer flex items-start gap-3 border group ${
                              isDark
                                ? "bg-slate-950/60 hover:bg-slate-800/80 border-slate-800 hover:border-indigo-500/50"
                                : "bg-slate-50/80 hover:bg-indigo-50/60 border-slate-200 hover:border-indigo-300 shadow-2xs"
                            }`}
                          >
                            <div
                              className={`p-2 rounded-xl border shrink-0 group-hover:scale-105 transition ${
                                isDark
                                  ? `${k.tone.borderDark} ${k.tone.bgDark}`
                                  : `${k.tone.borderLight} ${k.tone.bgLight}`
                              }`}
                            >
                              <Icon size={16} className={isDark ? k.tone.textDark : k.tone.textLight} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-bold group-hover:text-indigo-600 transition">
                                  {k.label}
                                </h5>
                                <span className="text-[10px] text-slate-400 font-mono">+{k.badge}</span>
                              </div>
                              <p className="text-[11px] text-slate-500 leading-snug mt-0.5">{k.shortDesc}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 6. TEMPLATES GALLERY MODAL                                */}
      {/* ========================================================= */}
      {showTemplatesModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-6">
          <div
            className={`border rounded-3xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 ${
              isDark ? "bg-slate-900 border-slate-800 text-white" : "bg-white border-slate-200 text-slate-900"
            }`}
          >
            <div className={`px-6 py-4 border-b flex items-center justify-between ${isDark ? "border-slate-800" : "border-slate-200"}`}>
              <div className="flex items-center gap-2.5">
                <Sparkles size={18} className="text-amber-500" />
                <h3 className="text-sm font-bold">Pre-built n8n-Style Workflow Graphs</h3>
              </div>
              <button
                onClick={() => setShowTemplatesModal(false)}
                className={`p-1.5 rounded-lg cursor-pointer ${
                  isDark ? "text-slate-400 hover:text-white hover:bg-slate-800" : "text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                }`}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-3">
              {TEMPLATES.map((tmpl) => (
                <div
                  key={tmpl.id}
                  className={`border rounded-2xl p-4 transition flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                    isDark
                      ? "border-slate-800 hover:border-indigo-500 bg-slate-950/60"
                      : "border-slate-200 hover:border-indigo-400 bg-slate-50/60 shadow-2xs"
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200">
                        {tmpl.category}
                      </span>
                      <h4 className="text-sm font-bold">{tmpl.name}</h4>
                    </div>
                    <p className="text-xs text-slate-500 leading-relaxed">{tmpl.description}</p>
                    <div className="text-[11px] text-slate-400 font-mono pt-1">
                      {tmpl.nodes.length} Nodes • Triggers: {tmpl.triggers.join(", ")}
                    </div>
                  </div>

                  <button
                    onClick={() => handleCreateFromTemplate(tmpl)}
                    className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition cursor-pointer shadow-xs shrink-0 active:scale-98"
                  >
                    Instantiate Graph
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 7. YAML SPEC MODAL                                        */}
      {/* ========================================================= */}
      {showYamlModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-6">
          <div
            className={`border rounded-3xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 ${
              isDark ? "bg-slate-900 border-slate-800 text-white" : "bg-white border-slate-200 text-slate-900"
            }`}
          >
            <div className={`px-6 py-4 border-b flex items-center justify-between ${isDark ? "border-slate-800" : "border-slate-200"}`}>
              <div className="flex items-center gap-2">
                <FileCode2 size={16} className="text-indigo-600" />
                <h3 className="text-sm font-bold">Declarative Graph Spec (YAML)</h3>
              </div>
              <button
                onClick={() => setShowYamlModal(false)}
                className={`p-1.5 rounded-lg cursor-pointer ${
                  isDark ? "text-slate-400 hover:text-white hover:bg-slate-800" : "text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                }`}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-6 flex-1 flex flex-col space-y-3 overflow-hidden">
              <textarea
                value={yamlEditorDraft}
                onChange={(e) => setYamlEditorDraft(e.target.value)}
                className={`flex-1 w-full p-4 font-mono text-xs rounded-2xl outline-none focus:ring-1 focus:ring-indigo-500 resize-none min-h-[300px] border ${
                  isDark
                    ? "bg-slate-950 text-emerald-400 border-slate-800"
                    : "bg-slate-50 text-slate-800 border-slate-200"
                }`}
                spellCheck={false}
              />
            </div>

            <div className={`px-6 py-3 border-t flex items-center justify-between ${isDark ? "border-slate-800" : "border-slate-200"}`}>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(yaml);
                  setCopiedYaml(true);
                  setTimeout(() => setCopiedYaml(false), 2000);
                }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition cursor-pointer border ${
                  isDark
                    ? "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
                    : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
                }`}
              >
                {copiedYaml ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                <span>{copiedYaml ? "Copied" : "Copy YAML"}</span>
              </button>

              <button
                onClick={() => setShowYamlModal(false)}
                className="px-3.5 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg cursor-pointer shadow-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 8. DELETE CONFIRMATION DIALOG                             */}
      {/* ========================================================= */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            className={`border rounded-2xl max-w-sm w-full p-5 shadow-2xl space-y-3 ${
              isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200 text-slate-900"
            }`}
          >
            <div className="flex items-center gap-2.5 text-rose-500">
              <AlertCircle size={20} />
              <h4 className="text-sm font-bold">Delete Workflow?</h4>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              Are you sure you want to delete this workflow and all its connected nodes? This action cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                  isDark ? "text-slate-400 hover:bg-slate-800" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteWorkflow(confirmDeleteId)}
                className="px-3.5 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer transition shadow-xs"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// 5. Helpers & YAML Generator
// ==========================================
function statusTone(status: string, isDark: boolean) {
  if (status === "completed" || status === "done")
    return isDark
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "error")
    return isDark
      ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
      : "bg-rose-50 text-rose-700 border-rose-200";
  if (status === "running")
    return isDark
      ? "bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse"
      : "bg-blue-50 text-blue-700 border-blue-200 animate-pulse";
  if (status.includes("paused"))
    return isDark
      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
      : "bg-amber-50 text-amber-800 border-amber-200";
  return isDark ? "bg-slate-800 text-slate-400 border-slate-700" : "bg-slate-100 text-slate-600 border-slate-200";
}

function statusDot(status: string) {
  if (status === "completed" || status === "done") return "bg-emerald-500";
  if (status === "error") return "bg-rose-500";
  if (status === "running") return "bg-blue-500 animate-ping";
  if (status.includes("paused")) return "bg-amber-500";
  return "bg-slate-400";
}

function nodeStatusTone(status: string, isDark: boolean) {
  if (status === "completed" || status === "done")
    return isDark
      ? "bg-emerald-950/60 text-emerald-300 border-emerald-800"
      : "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "error")
    return isDark
      ? "bg-rose-950/60 text-rose-300 border-rose-800"
      : "bg-rose-50 text-rose-700 border-rose-200";
  if (status === "running")
    return isDark
      ? "bg-blue-950/60 text-blue-300 border-blue-800 animate-pulse"
      : "bg-blue-50 text-blue-700 border-blue-200 animate-pulse";
  if (status === "paused")
    return isDark
      ? "bg-amber-950/60 text-amber-300 border-amber-800"
      : "bg-amber-50 text-amber-800 border-amber-300";
  return isDark ? "bg-slate-800 text-slate-400 border-slate-700" : "bg-slate-100 text-slate-600 border-slate-200";
}

function nodeStatusIcon(status: string) {
  if (status === "completed" || status === "done") return <CheckCircle2 size={11} className="text-emerald-500" />;
  if (status === "error") return <AlertCircle size={11} className="text-rose-500" />;
  if (status === "running") return <Play size={10} className="text-blue-500 animate-spin" />;
  if (status === "paused") return <Pause size={10} className="text-amber-500" />;
  return <Clock size={10} className="text-slate-400" />;
}

function yamlStr(s: string) {
  if (!s || /[:#"'\n]/.test(s) || s.startsWith(" "))
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
  return s;
}

function emitYaml(
  wf: Partial<Workflow> & {
    id: string;
    name: string;
    currentStatus?: string;
    pausedAtNodeId?: string | null;
    triggers?: string[];
  },
  nodes: WfNode[]
) {
  const paused = wf.pausedAtNodeId ? `paused_at: ${yamlStr(wf.pausedAtNodeId)}\n` : "";
  const triggers = (wf.triggers ?? []).map((t) => `  - ${yamlStr(t)}`).join("\n");
  const nodeBlock = nodes
    .map(
      (n) => `  - id: ${yamlStr(n.id)}
    name: ${yamlStr(n.name)}
    kind: ${yamlStr(n.kind)}
    bot: ${yamlStr(n.botProfile)}
    model: ${yamlStr(n.model)}
    status: ${yamlStr(n.status)}
    latency_ms: ${n.latencyMs}
    prompt: ${yamlStr(n.prompt)}`
    )
    .join("\n");
  return `id: ${yamlStr(wf.id)}
name: ${yamlStr(wf.name)}
status: ${yamlStr(wf.currentStatus || "idle")}
${paused}triggers:
${triggers ? `${triggers}\n` : ""}nodes:
${nodeBlock}
`;
}
