export type ScreenId =
  | "onboarding"
  | "chat"
  | "bots"
  | "profiles"
  | "providers"
  | "memory"
  | "skills"
  | "mesh"
  | "harness2"
  | "capabilities"
  | "fleet"
  | "ide"
  | "computer"
  | "workflows"
  | "market"
  | "wallet"
  | "extensions"
  | "billing"
  | "repair"
  | "settings"
  | "vault";

export type BotProfile = {
  id: string;
  handle: string;
  displayName: string;
  avatar: string;
  avatarColor: string;
  soulMarkdown: string;
  primaryAccountId: string;
  longContextAccountId: string;
  fallbackAccountId: string;
  allowComputerUse: boolean;
  allowBrowserUse: boolean;
  allowCodeExec: boolean;
  scopedObsidianFolder: string;
  dailyWalletLimitUsd: number;
  isPinned: boolean;
  role: string;
  engine: string;
  commandOrUrl: string;
  runStatus: string;
  activePid: number | null;
  statusLine: string;
  harnessLaneId: string;
  agUiEndpointUrl: string;
  browserPartition: string;
  workspaceDir: string;
  allowFileWrite: boolean;
  requireApprovalExternal: boolean;
  requireApprovalWallet: boolean;
  stallTimeoutMs: number;
  workspaceFiles: string[];
  takeover: boolean;
  screenUrl: string;
  screenNodes: DomNode[];
  screenMs: number;
  shellOutput: string;
};

export type BotGroup = {
  id: string;
  groupHandle: string;
  title: string;
  purpose: string;
  coordinationMode: "autonomous_handoff" | "parallel_swarm" | "lead_delegated" | string;
  leadBotId: string;
  memberBotIds: string[];
  sharedWorkspaceDir: string;
  routineSchedule: string;
  createdAt: number;
};

export type GatewayAudit = {
  id: string;
  botId: string;
  botHandle: string;
  conversationId: string;
  toolOrSurface: string;
  targetResource: string;
  gatewayDecision: "allowed" | "held_for_approval" | "denied_by_rule" | "stalled" | string;
  ruleMatched: string;
  recordedAt: number;
};

export type ChatThread = {
  id: string;
  botProfileId: string;
  title: string;
  activeModelOverrideId: string | null;
  status: "idle" | "running" | "paused" | "completed" | "error";
  compactedContextCapsule: string;
  isPinned: boolean;
  updatedAt: number;
  targetType: string;
  groupId: string;
  routineSchedule: string;
};

export type StepPayload = Record<string, unknown>;

export type Step = {
  id: string;
  threadId: string;
  turnId?: string;
  role: "user" | "assistant" | "tool" | "system";
  modelUsed: string;
  contentMarkdown: string;
  actionType:
    | "message"
    | "code_diff"
    | "pty_terminal"
    | "cdp_browser"
    | "browser_inspect"
    | "handoff_capsule"
    | "bot_handoff"
    | "gateway_approval"
    | "wallet_tx"
    | "plan"
    | "thinking"
    | "harness2_pipeline";
  actionPayload: StepPayload;
  executionLatencyMs: number;
  createdAt: number;
};

export type ProviderType =
  | "cli_subprocess"
  | "official_oauth"
  | "isolated_webview"
  | "byok_api"
  | "local_ollama";

export type Provider = {
  id: string;
  name: string;
  providerType: ProviderType;
  binaryOrEndpoint: string;
  hasSecret: boolean;
  quotaWindowHours: number;
  quotaUsedPercent: number;
  quotaResetsAt: string;
  fallbackAccountId: string | null;
  isActive: boolean;
  allowCliDispatch: boolean;
  lastHealthCheckMs: number | null;
  healthDetail: string;
};

export type LinkedApp = {
  id: string;
  appName: string;
  category: string;
  executablePath: string;
  bridgeProtocol: string;
  activePid: number | null;
  localPort: number | null;
  status: string;
  detail: string;
};

export type MemoryItem = {
  id: string;
  sourceType: string;
  scopedBotId: string | null;
  filePathOrUri: string;
  title: string;
  contentMarkdown: string;
  wikilinks: string[];
  updatedAt: number;
  engineOrigin: string;
  syncedEngines: string[];
  validFrom?: number | null;
  invalidAt?: number | null;
};

export type MemoryEngine = {
  id: string;
  label: string;
  kind: string;
  availability: string;
  endpoint: string;
  detail: string;
  latencyMs: number | null;
  scannedAt: number;
};

export type MemoryRoute = {
  id: string;
  scope: string;
  engineId: string;
  companionEngineId: string | null;
  updatedAt: number;
};

export type ProfileFlag = { profileId: string; enabled: boolean };

export type SkillFile = { path: string; kind: string; content: string };

export type Skill = {
  id: string;
  slug: string;
  origin: string;
  ownerProfileId: string;
  pluginId: string;
  title: string;
  description: string;
  slashCommand: string;
  requiresTools: string[];
  platforms: string[];
  body: string;
  files: SkillFile[];
  enables: ProfileFlag[];
  hiddenReason: string;
  indexLine: string;
  version: string;
  updatedAt: number;
};

export type DeclaredTool = { name: string; description: string };

export type DesktopBit = { kind: string; label: string; target: string };

export type PluginPackage = {
  id: string;
  slug: string;
  name: string;
  version: string;
  source: string;
  sourcePath: string;
  trust: string;
  hasAgent: boolean;
  hasDesktop: boolean;
  tools: DeclaredTool[];
  hooks: string[];
  bundledSkills: string[];
  desktop: DesktopBit[];
  agentEnables: ProfileFlag[];
  desktopEnabled: boolean;
};

export type McpServer = {
  id: string;
  name: string;
  transport: string;
  command: string;
  args: string[];
  url: string;
  trust: string;
  declaredTools: DeclaredTool[];
  enables: ProfileFlag[];
  lastError: string;
};

export type SkillProposal = {
  id: string;
  profileId: string;
  threadId: string;
  slug: string;
  description: string;
  proposedBody: string;
  currentBody: string;
  status: string;
  createdAt: number;
};

export type RegistryTool = {
  name: string;
  description: string;
  source: string;
  available: boolean;
  reason: string;
};

export type WfNode = {
  id: string;
  name: string;
  kind: string;
  botProfile: string;
  model: string;
  prompt: string;
  status: "done" | "paused" | "pending" | "running" | "error";
  latencyMs: number;
};

export type Workflow = {
  id: string;
  name: string;
  yamlSource: string;
  nodes: WfNode[];
  triggers: string[];
  currentStatus: string;
  pausedAtNodeId: string | null;
  checkpoint: Record<string, string>;
  updatedAt: number;
};

export type Policy = {
  maxPerTxUsd: number;
  dailyCapUsd: number;
  requireHumanApprovalAboveUsd: number;
  maxSlippageBps: number;
  killswitchEngaged: boolean;
  whitelisted: string[];
};

export type Balance = {
  rail: string;
  label: string;
  amountUsd: number;
  nativeAmount: string;
  nativeValue: number;
  detail: string;
};

export type WalletTx = {
  id: string;
  botProfileId: string | null;
  botHandle: string;
  rail: string;
  amountUsd: number;
  nativeAmount: string;
  counterparty: string;
  purpose: string;
  policyDecision: string;
  txHashOrRef: string;
  createdAt: number;
  actor: string;
  effect?: string;
};

export type Position = {
  symbol: string;
  venue: string;
  side: string;
  pnlUsd: number;
  open: boolean;
};

export type Remediation = {
  id: string;
  tier: number;
  faultType: string;
  targetComponent: string;
  actionTaken: string;
  recoveryDurationMs: number;
  status: string;
  createdAt: number;
};

export type ProcessRow = {
  name: string;
  pid: number | null;
  detail: string;
  health: string;
};

export type FleetLog = {
  id: string;
  botName: string;
  stream: string;
  line: string;
  createdAt: number;
};

export type Extension = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  code: string;
};

export type LicenseInfo = {
  planTier: "free" | "pro" | "founder_lifetime" | "team" | string;
  status: "active" | "expired" | "invalid" | "unsigned_dev" | "none" | string;
  founderBadge: number | null;
  maxDevices: number;
  walletMicroUsd: number;
  leaseExpUnix: number;
  hardwareHash: string;
};

export type MarketItem = {
  slug: string;
  title: string;
  author: string;
  category: string;
  blurb: string;
  installed: boolean;
  verified: boolean;
  price: string;
};

export type Settings = {
  theme: "light" | "contrast" | "dark";
  density: "minimal" | "standard" | "dense";
  projectRoot: string;
  obsidianVault: string;
  watchdogEnabled: boolean;
  hotpatchEnabled: boolean;
  shadowGit: boolean;
  autoFailover: boolean;
  autoActUnderUsd: number;
  updateChannel: "stable" | "nightly";
  version: string;
  availableVersion: string;
  plan: string;
  burstCreditsUsd: number;
  ghostRunners: string[];
  liveRails: boolean;
  triageUrl: string;
  claudePath: string;
  codexPath: string;
  geminiPath: string;
  aiderPath: string;
  opencodePath: string;
  uvPath: string;
  bunPath: string;
  showRailLabels: boolean;
};

export type ScanHit = { name: string; path: string; category: string };

export type ScanReport = {
  durationMs: number;
  found: ScanHit[];
  missing: string[];
};

export type DomNode = { id: number; tag: string; label: string; kind: string };

export type Snapshot = {
  homeDir: string;
  onboardingComplete: boolean;
  vaultUnlocked: boolean;
  hasPassphrase: boolean;
  sandbox: boolean;
  kernel: "rust" | "browser";
  activeProfileId: string;
  activeThreadId: string | null;
  profiles: BotProfile[];
  threads: ChatThread[];
  steps: Step[];
  botGroups: BotGroup[];
  gatewayAudits: GatewayAudit[];
  providers: Provider[];
  apps: LinkedApp[];
  memories: MemoryItem[];
  memoryEngines: MemoryEngine[];
  memoryRoute: MemoryRoute;
  memoryRoutes: MemoryRoute[];
  skills: Skill[];
  plugins: PluginPackage[];
  mcpServers: McpServer[];
  skillProposals: SkillProposal[];
  registry: RegistryTool[];
  skillIndexDelta: string;
  workflows: Workflow[];
  policy: Policy;
  balances: Balance[];
  transactions: WalletTx[];
  positions: Position[];
  remediation: Remediation[];
  processes: ProcessRow[];
  fleetLogs: FleetLog[];
  extensions: Extension[];
  marketplace: MarketItem[];
  settings: Settings;
  scan: ScanReport | null;
  proxyUrl: string;
  heartbeatAgeMs: number;
  ipcLog: string[];
  quoteBtc: string;
  quoteNifty: string;
  spentTodayUsd: number;
  ideAgent: string;
  computerUrl: string;
  domNodes: DomNode[];
  domLatencyMs: number;
  sandboxOutput: string;
  bugPreview: string;
  license: LicenseInfo;
};

export type CommandResult = { snapshot: Snapshot; toast: string | null; installChoice?: string | null; payload?: unknown };

export const RAIL: { id: ScreenId; label: string; group: "main" | "tail" }[] = [
  { id: "chat", label: "Bots & groups", group: "main" },
  { id: "bots", label: "External bots", group: "main" },
  { id: "providers", label: "Apps & providers", group: "main" },
  { id: "memory", label: "Memory", group: "main" },
  { id: "skills", label: "Skills & Capabilities", group: "main" },
  { id: "mesh", label: "MCP & ACP mesh", group: "main" },
  { id: "harness2", label: "Harness²", group: "main" },
  { id: "fleet", label: "Bot fleet", group: "main" },
  { id: "ide", label: "Coding agents", group: "main" },
  { id: "computer", label: "Computer & browser", group: "main" },
  { id: "workflows", label: "Workflows", group: "main" },
  { id: "market", label: "Marketplace", group: "main" },
  { id: "wallet", label: "Wallet & trading", group: "main" },
  { id: "extensions", label: "Self-modify", group: "tail" },
  { id: "repair", label: "Self-repair", group: "tail" },
  { id: "billing", label: "Plan & act", group: "tail" },
  { id: "settings", label: "Settings", group: "tail" },
];
