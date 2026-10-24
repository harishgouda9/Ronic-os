use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    pub avatar: String,
    pub soul_markdown: String,
    pub primary_account_id: String,
    pub long_context_account_id: String,
    pub fallback_account_id: String,
    pub allow_computer_use: bool,
    pub allow_browser_use: bool,
    pub allow_code_exec: bool,
    pub scoped_obsidian_folder: String,
    pub daily_wallet_limit_usd: f64,
    pub is_pinned: bool,
    pub role: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub command_or_url: String,
    #[serde(default)]
    pub run_status: String,
    #[serde(default)]
    pub active_pid: Option<i64>,
    #[serde(default = "ready_line")]
    pub status_line: String,
    #[serde(default)]
    pub harness_lane_id: String,
    #[serde(default)]
    pub ag_ui_endpoint_url: String,
    #[serde(default)]
    pub browser_partition: String,
    #[serde(default)]
    pub workspace_dir: String,
    #[serde(default = "default_true")]
    pub allow_file_write: bool,
    #[serde(default = "default_true")]
    pub require_approval_external: bool,
    #[serde(default = "default_true")]
    pub require_approval_wallet: bool,
    #[serde(default = "default_stall")]
    pub stall_timeout_ms: i64,
    #[serde(default)]
    pub workspace_files: Vec<String>,
    #[serde(default)]
    pub takeover: bool,
    #[serde(default)]
    pub screen_url: String,
    #[serde(default)]
    pub screen_nodes: Vec<DomNode>,
    #[serde(default)]
    pub screen_ms: i64,
    #[serde(default)]
    pub shell_output: String,
    #[serde(default)]
    pub avatar_color: String,
}

fn ready_line() -> String {
    "Ready for tasks".into()
}

fn default_true() -> bool {
    true
}

fn default_stall() -> i64 {
    45_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub bot_profile_id: String,
    pub title: String,
    pub active_model_override_id: Option<String>,
    pub status: String,
    pub compacted_context_capsule: String,
    pub is_pinned: bool,
    pub updated_at: i64,
    #[serde(default = "direct_bot")]
    pub target_type: String,
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub routine_schedule: String,
}

fn direct_bot() -> String {
    "direct_bot".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotGroup {
    pub id: String,
    pub group_handle: String,
    pub title: String,
    pub purpose: String,
    pub coordination_mode: String,
    pub lead_bot_id: String,
    pub member_bot_ids: Vec<String>,
    pub shared_workspace_dir: String,
    pub routine_schedule: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayAudit {
    pub id: String,
    pub bot_id: String,
    pub bot_handle: String,
    pub conversation_id: String,
    pub tool_or_surface: String,
    pub target_resource: String,
    pub gateway_decision: String,
    pub rule_matched: String,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub thread_id: String,
    #[serde(default)]
    pub turn_id: String,
    pub role: String,
    pub model_used: String,
    pub content_markdown: String,
    pub action_type: String,
    pub action_payload: Value,
    pub execution_latency_ms: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub binary_or_endpoint: String,
    pub has_secret: bool,
    pub quota_window_hours: i64,
    pub quota_used_percent: f64,
    pub quota_resets_at: String,
    pub fallback_account_id: Option<String>,
    pub is_active: bool,
    pub allow_cli_dispatch: bool,
    pub last_health_check_ms: Option<i64>,
    pub health_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedApp {
    pub id: String,
    pub app_name: String,
    pub category: String,
    pub executable_path: String,
    pub bridge_protocol: String,
    pub active_pid: Option<i64>,
    pub local_port: Option<i64>,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub source_type: String,
    pub scoped_bot_id: Option<String>,
    pub file_path_or_uri: String,
    pub title: String,
    pub content_markdown: String,
    pub wikilinks: Vec<String>,
    pub updated_at: i64,
    pub engine_origin: String,
    pub synced_engines: Vec<String>,
    pub valid_from: Option<i64>,
    pub invalid_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEngine {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub availability: String,
    pub endpoint: String,
    pub detail: String,
    pub latency_ms: Option<i64>,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRoute {
    pub id: String,
    pub scope: String,
    pub engine_id: String,
    pub companion_engine_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFlag {
    pub profile_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: String,
    pub kind: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub slug: String,
    pub origin: String,
    pub owner_profile_id: String,
    pub plugin_id: String,
    pub title: String,
    pub description: String,
    pub slash_command: String,
    pub requires_tools: Vec<String>,
    pub platforms: Vec<String>,
    pub body: String,
    pub files: Vec<SkillFile>,
    pub enables: Vec<ProfileFlag>,
    pub hidden_reason: String,
    pub index_line: String,
    pub version: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredTool {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBit {
    pub kind: String,
    pub label: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackage {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub source_path: String,
    pub trust: String,
    pub has_agent: bool,
    pub has_desktop: bool,
    pub tools: Vec<DeclaredTool>,
    pub hooks: Vec<String>,
    pub bundled_skills: Vec<String>,
    pub desktop: Vec<DesktopBit>,
    pub agent_enables: Vec<ProfileFlag>,
    pub desktop_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub trust: String,
    pub declared_tools: Vec<DeclaredTool>,
    pub enables: Vec<ProfileFlag>,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProposal {
    pub id: String,
    pub profile_id: String,
    pub thread_id: String,
    pub slug: String,
    pub description: String,
    pub proposed_body: String,
    pub current_body: String,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryTool {
    pub name: String,
    pub description: String,
    pub source: String,
    pub available: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WfNode {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub bot_profile: String,
    pub model: String,
    pub prompt: String,
    pub status: String,
    pub latency_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub yaml_source: String,
    pub nodes: Vec<WfNode>,
    pub triggers: Vec<String>,
    pub current_status: String,
    pub paused_at_node_id: Option<String>,
    pub checkpoint: serde_json::Map<String, Value>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub max_per_tx_usd: f64,
    pub daily_cap_usd: f64,
    pub require_human_approval_above_usd: f64,
    pub max_slippage_bps: i64,
    pub killswitch_engaged: bool,
    pub whitelisted: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub rail: String,
    pub label: String,
    pub amount_usd: f64,
    pub native_amount: String,
    pub native_value: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletTx {
    pub id: String,
    pub bot_profile_id: Option<String>,
    pub bot_handle: String,
    pub rail: String,
    pub amount_usd: f64,
    pub native_amount: String,
    pub counterparty: String,
    pub purpose: String,
    pub policy_decision: String,
    pub tx_hash_or_ref: String,
    pub created_at: i64,
    pub actor: String,
    pub effect: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub symbol: String,
    pub venue: String,
    pub side: String,
    pub pnl_usd: f64,
    pub open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remediation {
    pub id: String,
    pub tier: i64,
    pub fault_type: String,
    pub target_component: String,
    pub action_taken: String,
    pub recovery_duration_ms: i64,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub name: String,
    pub pid: Option<i64>,
    pub detail: String,
    pub health: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetLog {
    pub id: String,
    pub bot_name: String,
    pub stream: String,
    pub line: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
    pub id: String,
    pub name: String,
    pub path: String,
    pub enabled: bool,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItem {
    pub slug: String,
    pub title: String,
    pub author: String,
    pub category: String,
    pub blurb: String,
    pub installed: bool,
    pub verified: bool,
    pub price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub density: String,
    pub project_root: String,
    pub obsidian_vault: String,
    pub watchdog_enabled: bool,
    pub hotpatch_enabled: bool,
    pub shadow_git: bool,
    pub auto_failover: bool,
    pub auto_act_under_usd: f64,
    pub update_channel: String,
    pub version: String,
    pub available_version: String,
    pub plan: String,
    pub burst_credits_usd: f64,
    pub ghost_runners: Vec<String>,
    pub live_rails: bool,
    pub triage_url: String,
    pub claude_path: String,
    pub codex_path: String,
    pub gemini_path: String,
    pub aider_path: String,
    pub opencode_path: String,
    pub uv_path: String,
    pub bun_path: String,
    pub show_rail_labels: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            density: "standard".into(),
            project_root: String::new(),
            obsidian_vault: String::new(),
            watchdog_enabled: true,
            hotpatch_enabled: true,
            shadow_git: true,
            auto_failover: true,
            auto_act_under_usd: 0.5,
            update_channel: "stable".into(),
            version: "2.1.4".into(),
            available_version: "2.1.4".into(),
            plan: "Local".into(),
            burst_credits_usd: 0.0,
            ghost_runners: Vec::new(),
            live_rails: false,
            triage_url: String::new(),
            claude_path: String::new(),
            codex_path: String::new(),
            gemini_path: String::new(),
            aider_path: String::new(),
            opencode_path: String::new(),
            uv_path: String::new(),
            bun_path: String::new(),
            show_rail_labels: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHit {
    pub name: String,
    pub path: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub duration_ms: i64,
    pub found: Vec<ScanHit>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomNode {
    pub id: i64,
    pub tag: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub home_dir: String,
    pub onboarding_complete: bool,
    pub vault_unlocked: bool,
    pub has_passphrase: bool,
    pub sandbox: bool,
    pub kernel: String,
    pub active_profile_id: String,
    pub active_thread_id: Option<String>,
    pub profiles: Vec<BotProfile>,
    pub threads: Vec<ChatThread>,
    pub steps: Vec<Step>,
    pub bot_groups: Vec<BotGroup>,
    pub gateway_audits: Vec<GatewayAudit>,
    pub providers: Vec<Provider>,
    pub apps: Vec<LinkedApp>,
    pub memories: Vec<MemoryItem>,
    pub memory_engines: Vec<MemoryEngine>,
    pub memory_route: MemoryRoute,
    pub memory_routes: Vec<MemoryRoute>,
    pub skills: Vec<Skill>,
    pub plugins: Vec<PluginPackage>,
    pub mcp_servers: Vec<McpServer>,
    pub skill_proposals: Vec<SkillProposal>,
    pub registry: Vec<RegistryTool>,
    pub skill_index_delta: String,
    pub workflows: Vec<Workflow>,
    pub policy: Policy,
    pub balances: Vec<Balance>,
    pub transactions: Vec<WalletTx>,
    pub positions: Vec<Position>,
    pub remediation: Vec<Remediation>,
    pub processes: Vec<ProcessRow>,
    pub fleet_logs: Vec<FleetLog>,
    pub extensions: Vec<Extension>,
    pub marketplace: Vec<MarketItem>,
    pub settings: Settings,
    pub scan: Option<ScanReport>,
    pub proxy_url: String,
    pub heartbeat_age_ms: i64,
    pub ipc_log: Vec<String>,
    pub quote_btc: String,
    pub quote_nifty: String,
    pub spent_today_usd: f64,
    pub ide_agent: String,
    pub computer_url: String,
    pub dom_nodes: Vec<DomNode>,
    pub dom_latency_ms: i64,
    pub sandbox_output: String,
    pub bug_preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub snapshot: Snapshot,
    pub toast: Option<String>,
    /// Set when a desktop tile has neither a desktop nor a terminal program yet.
    /// The dock asks which one to install. Nothing is installed until the user chooses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_choice: Option<String>,
    /// Structured result for commands that return more than a toast, such as the git working tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

pub fn catalog() -> Vec<MarketItem> {
    vec![
        MarketItem {
            slug: "notion-mcp".into(),
            title: "Notion".into(),
            author: "notion-official".into(),
            category: "Productivity".into(),
            blurb: "Notion's remote MCP server for database queries and page creation.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "linear-mcp".into(),
            title: "Linear".into(),
            author: "linear-official".into(),
            category: "Productivity".into(),
            blurb: "Linear's remote MCP server for issues, cycles, and roadmaps.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "sentry-mcp".into(),
            title: "Sentry".into(),
            author: "sentry-official".into(),
            category: "Code & Reverse Engineering".into(),
            blurb: "Sentry's remote MCP server for production stacktraces and release health.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "supabase-mcp".into(),
            title: "Supabase".into(),
            author: "supabase-official".into(),
            category: "Code & Reverse Engineering".into(),
            blurb: "Supabase MCP server for Postgres schema inspection and migrations.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "composio".into(),
            title: "Composio".into(),
            author: "ComposioHQ/composio".into(),
            category: "Productivity".into(),
            blurb: "Prebuilt skill from ComposioHQ. Routes Composio For You and 1,500+ app actions.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "composio-mcp".into(),
            title: "Composio MCP".into(),
            author: "ComposioHQ".into(),
            category: "Productivity".into(),
            blurb: "Composio MCP at connect.composio.dev/mcp with OS Keychain Vault authentication.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "github-mcp".into(),
            title: "GitHub MCP".into(),
            author: "github/github-mcp".into(),
            category: "Code & Reverse Engineering".into(),
            blurb: "GitHub MCP server for PR automation, code search, and review routines.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "slack-mcp".into(),
            title: "Slack MCP".into(),
            author: "slack-official".into(),
            category: "Productivity".into(),
            blurb: "Slack integration to dispatch bot updates, monitor channels, and post daily summaries.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "filesystem-mcp".into(),
            title: "Filesystem MCP".into(),
            author: "modelcontextprotocol/filesystem".into(),
            category: "Code & Reverse Engineering".into(),
            blurb: "Official local filesystem MCP server for directory navigation and file I/O.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "memory-mcp".into(),
            title: "Memory MCP".into(),
            author: "modelcontextprotocol/memory".into(),
            category: "Supercharge & Bots".into(),
            blurb: "Official local graph memory MCP server for relational knowledge graphs.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "rea".into(),
            title: "REA — Reverse Engineer Anything".into(),
            author: "github.com/morluto/rea".into(),
            category: "Code & Reverse Engineering".into(),
            blurb: "Decompile and inspect native binaries, Electron ASARs, and minified JS bundles.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "playwright-cdp".into(),
            title: "Playwright MCP".into(),
            author: "microsoft/playwright".into(),
            category: "Code & Reverse Engineering".into(),
            blurb: "Playwright MCP server started with npx @playwright/mcp.".into(),
            installed: false,
            verified: true,
            price: "Free".into(),
        },
        MarketItem {
            slug: "razorpay-upi".into(),
            title: "Razorpay MCP".into(),
            author: "razorpay/razorpay-mcp".into(),
            category: "Quant & FinTech".into(),
            blurb: "Razorpay MCP server. The key is stored locally and the server starts with npx.".into(),
            installed: false,
            verified: false,
            price: "Free".into(),
        },
    ]
}
