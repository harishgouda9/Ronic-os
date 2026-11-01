use crate::error::{err, Result};
use crate::models::*;
use crate::util::{nid, now_ms};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", "5000")?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    let mut stmt = conn.prepare("PRAGMA table_info(wallet_transactions)")?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if !names.iter().any(|name| name == "effect") {
        conn.execute("ALTER TABLE wallet_transactions ADD COLUMN effect TEXT NOT NULL DEFAULT 'spend'", [])?;
    }
    ensure_column(conn, "bot_profiles", "engine", "ALTER TABLE bot_profiles ADD COLUMN engine TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "command_or_url", "ALTER TABLE bot_profiles ADD COLUMN command_or_url TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "run_status", "ALTER TABLE bot_profiles ADD COLUMN run_status TEXT NOT NULL DEFAULT 'stopped'")?;
    ensure_column(conn, "bot_profiles", "active_pid", "ALTER TABLE bot_profiles ADD COLUMN active_pid INTEGER")?;
    ensure_column(conn, "bot_profiles", "status_line", "ALTER TABLE bot_profiles ADD COLUMN status_line TEXT NOT NULL DEFAULT 'Ready for tasks'")?;
    ensure_column(conn, "bot_profiles", "harness_lane_id", "ALTER TABLE bot_profiles ADD COLUMN harness_lane_id TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "ag_ui_endpoint_url", "ALTER TABLE bot_profiles ADD COLUMN ag_ui_endpoint_url TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "browser_partition", "ALTER TABLE bot_profiles ADD COLUMN browser_partition TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "engine_kind", "ALTER TABLE bot_profiles ADD COLUMN engine_kind TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "api_base", "ALTER TABLE bot_profiles ADD COLUMN api_base TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "api_model", "ALTER TABLE bot_profiles ADD COLUMN api_model TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "workspace_dir", "ALTER TABLE bot_profiles ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "allow_file_write", "ALTER TABLE bot_profiles ADD COLUMN allow_file_write INTEGER NOT NULL DEFAULT 1")?;
    ensure_column(conn, "bot_profiles", "require_approval_external", "ALTER TABLE bot_profiles ADD COLUMN require_approval_external INTEGER NOT NULL DEFAULT 1")?;
    ensure_column(conn, "bot_profiles", "require_approval_wallet", "ALTER TABLE bot_profiles ADD COLUMN require_approval_wallet INTEGER NOT NULL DEFAULT 1")?;
    ensure_column(conn, "bot_profiles", "approval_mode", "ALTER TABLE bot_profiles ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'ask'")?;
    ensure_column(conn, "bot_profiles", "stall_timeout_ms", "ALTER TABLE bot_profiles ADD COLUMN stall_timeout_ms INTEGER NOT NULL DEFAULT 45000")?;
    ensure_column(conn, "bot_profiles", "avatar_color", "ALTER TABLE bot_profiles ADD COLUMN avatar_color TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "bot_profiles", "wallet_frozen", "ALTER TABLE bot_profiles ADD COLUMN wallet_frozen INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "chat_threads", "target_type", "ALTER TABLE chat_threads ADD COLUMN target_type TEXT NOT NULL DEFAULT 'direct_bot'")?;
    ensure_column(conn, "chat_threads", "group_id", "ALTER TABLE chat_threads ADD COLUMN group_id TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "chat_threads", "routine_schedule", "ALTER TABLE chat_threads ADD COLUMN routine_schedule TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "memory_items", "engine_origin", "ALTER TABLE memory_items ADD COLUMN engine_origin TEXT NOT NULL DEFAULT 'mem0_builtin'")?;
    ensure_column(conn, "memory_items", "valid_from", "ALTER TABLE memory_items ADD COLUMN valid_from INTEGER")?;
    ensure_column(conn, "memory_items", "invalid_at", "ALTER TABLE memory_items ADD COLUMN invalid_at INTEGER")?;
    ensure_column(conn, "memory_items", "external_id", "ALTER TABLE memory_items ADD COLUMN external_id TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "memory_items", "sync_json", "ALTER TABLE memory_items ADD COLUMN sync_json TEXT NOT NULL DEFAULT '{}'")?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS memory_items_obsidian_external_id ON memory_items(engine_origin, external_id) WHERE engine_origin='obsidian_khoj' AND external_id<>''",
        [],
    )?;
    ensure_column(conn, "execution_steps", "turn_id", "ALTER TABLE execution_steps ADD COLUMN turn_id TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "sentinels", "severity", "ALTER TABLE sentinels ADD COLUMN severity TEXT NOT NULL DEFAULT 'info'")?;
    ensure_column(conn, "sentinels", "acknowledged", "ALTER TABLE sentinels ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "quant_orders", "wallet_tx_id", "ALTER TABLE quant_orders ADD COLUMN wallet_tx_id TEXT")?;
    seed_memory_layer(conn)?;
    conn.execute(
        "UPDATE provider_accounts SET binary_or_endpoint = 'https://grok.com' WHERE binary_or_endpoint LIKE '%grok.x.ai%'",
        [],
    )?;
    let t = now_ms();
    for (id, name) in [("app_hermes", "Hermes"), ("app_openclaw", "OpenClaw")] {
        conn.execute(
            "INSERT OR IGNORE INTO linked_local_apps (id, app_name, category, executable_path, bridge_protocol, status, detail, updated_at) VALUES (?1,?2,'bot_daemon','','local_command','missing','Not found yet. Connect it from External bots.',?3)",
            params![id, name, t],
        )?;
    }
    for (id, name, endpoint, detail) in [
        ("prov_anthropic", "Anthropic", "https://api.anthropic.com", "Needs an API key. Claude.ai opens from the icon dock."),
        ("prov_tokenrouter", "TokenRouter", "https://api.tokenrouter.io/v1", "Needs an API key."),
        ("prov_bedrock", "Bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com", "Needs a Bedrock API key."),
        ("prov_nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1", "Needs an NVIDIA API key."),
        ("prov_mistral", "Mistral", "https://api.mistral.ai/v1", "Needs a Mistral API key. Le Chat opens from the model menu."),
        ("prov_groq", "Groq", "https://api.groq.com/openai/v1", "Needs a Groq API key."),
        ("prov_perplexity", "Perplexity", "https://api.perplexity.ai", "Needs a Perplexity API key. The site sign-in stays on perplexity.ai."),
        ("prov_together", "Together", "https://api.together.xyz/v1", "Needs a Together API key."),
        ("prov_cohere", "Cohere", "https://api.cohere.com/compatibility/v1", "Needs a Cohere API key."),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO provider_accounts (id, name, provider_type, binary_or_endpoint, has_secret, quota_window_hours, quota_used_percent, quota_resets_at, fallback_account_id, is_active, allow_cli_dispatch, health_detail, created_at) VALUES (?1,?2,'byok_api',?3,0,5,0,'','',1,0,?4,?5)",
            params![id, name, endpoint, detail, t],
        )?;
    }
    conn.execute(
        "UPDATE provider_accounts SET health_detail = 'Not signed in. Open the site, or paste an API key to chat here.' WHERE provider_type IN ('isolated_webview', 'official_oauth') AND (health_detail LIKE 'Connected%' OR health_detail LIKE 'Web Session%')",
        [],
    )?;
    let keyed: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM provider_accounts WHERE has_secret = 1 OR provider_type = 'local_ollama'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let pointed: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, fallback_account_id FROM provider_accounts WHERE COALESCE(fallback_account_id, '') != ''")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (id, fallback) in pointed {
        if !keyed.iter().any(|item| item == &fallback) {
            conn.execute("UPDATE provider_accounts SET fallback_account_id = '' WHERE id = ?1", params![id])?;
        }
    }
    crate::remediation_core::sentinels_ensure(conn)?;
    prune(conn)?;
    Ok(())
}

fn prune(conn: &Connection) -> Result<()> {
    let seven_days_ago = now_ms() - 7 * 86_400_000;
    conn.execute("DELETE FROM quant_orders WHERE created_at < ?1", params![seven_days_ago])?;
    conn.execute("DELETE FROM squad_shared_blackboard WHERE created_at < ?1", params![seven_days_ago])?;
    conn.execute("DELETE FROM sentinel_events WHERE created_at < ?1", params![seven_days_ago])?;
    conn.execute("DELETE FROM remediation_logs WHERE created_at < ?1", params![seven_days_ago])?;
    Ok(())
}

fn seed_memory_layer(conn: &Connection) -> Result<()> {
    let t = now_ms();
    let rows = [
        ("mem0_builtin", "Mem0 (built in)", "builtin", "builtin", "state.db", "Local Mem0 vault in this workspace. No extra process."),
        ("zep_graphiti", "Zep (Graphiti)", "external_mcp", "missing", "", "Looks for a server on 127.0.0.1:8000."),
        ("cognee", "Cognee", "external_mcp", "missing", "", "Looks for Cognee on 127.0.0.1:8000."),
        ("letta", "Letta", "external_mcp", "missing", "", "Looks for a server on 127.0.0.1:8283."),
        ("obsidian_khoj", "Obsidian", "vault", "missing", "", "Markdown vault and wikilinks."),
    ];
    for (id, label, kind, availability, endpoint, detail) in rows {
        conn.execute(
            "INSERT OR IGNORE INTO memory_engines (id, label, kind, availability, endpoint, detail, latency_ms, scanned_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,0)",
            params![id, label, kind, availability, endpoint, detail],
        )?;
        conn.execute("UPDATE memory_engines SET label=?1, kind=?2 WHERE id=?3", params![label, kind, id])?;
    }
    conn.execute(
        "UPDATE memory_engines SET availability='builtin', endpoint='state.db', detail='Local Mem0 vault in this workspace. No extra process.' WHERE id='mem0_builtin'",
        [],
    )?;
    conn.execute(
        "UPDATE memory_routes SET engine_id='mem0_builtin' WHERE engine_id IN ('openmemory_builtin', 'mem0_sdk')",
        [],
    )?;
    conn.execute(
        "UPDATE memory_items SET engine_origin='mem0_builtin' WHERE engine_origin IN ('openmemory_builtin', 'mem0_sdk', '')",
        [],
    )?;
    conn.execute("DELETE FROM memory_engines WHERE id IN ('openmemory_builtin', 'mem0_sdk')", [])?;
    conn.execute(
        "INSERT OR IGNORE INTO memory_routes (id, scope, engine_id, companion_engine_id, updated_at) VALUES ('global','global','mem0_builtin',NULL,?1)",
        params![t],
    )?;

    drop_demo_memories(conn)?;
    Ok(())
}

fn drop_demo_memories(conn: &Connection) -> Result<()> {
    let demo = [
        ("mem_101", "Core Desktop & Database Stack"),
        ("mem_102", "Supercharge (Harness²) Auto-Trigger Rule"),
        ("mem_103", "Wallet Policy & Hyperliquid Builder Rebate"),
        ("mem_104", "UI Design System Preference"),
    ];
    for (id, title) in demo {
        let removed = conn.execute("DELETE FROM memory_items WHERE id = ?1 AND title = ?2", params![id, title])?;
        if removed > 0 {
            conn.execute("DELETE FROM memory_embeddings WHERE memory_id = ?1", params![id])?;
            conn.execute("DELETE FROM memory_events WHERE memory_id = ?1", params![id])?;
        }
    }
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if !names.iter().any(|name| name == column) {
        conn.execute(ddl, [])?;
    }
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  binary_or_endpoint TEXT NOT NULL,
  has_secret INTEGER NOT NULL DEFAULT 0,
  quota_window_hours INTEGER NOT NULL DEFAULT 5,
  quota_used_percent REAL NOT NULL DEFAULT 0,
  quota_resets_at TEXT NOT NULL DEFAULT '',
  fallback_account_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  allow_cli_dispatch INTEGER NOT NULL DEFAULT 0,
  last_health_check_ms INTEGER,
  health_detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS linked_local_apps (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  category TEXT NOT NULL,
  executable_path TEXT NOT NULL,
  bridge_protocol TEXT NOT NULL,
  active_pid INTEGER,
  local_port INTEGER,
  status TEXT NOT NULL DEFAULT 'missing',
  detail TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_profiles (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  soul_markdown TEXT NOT NULL,
  primary_account_id TEXT NOT NULL,
  long_context_account_id TEXT NOT NULL,
  fallback_account_id TEXT NOT NULL,
  allow_computer_use INTEGER NOT NULL DEFAULT 1,
  allow_browser_use INTEGER NOT NULL DEFAULT 1,
  allow_code_exec INTEGER NOT NULL DEFAULT 1,
  scoped_obsidian_folder TEXT NOT NULL DEFAULT '',
  daily_wallet_limit_usd REAL NOT NULL DEFAULT 5,
  is_pinned INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  engine TEXT NOT NULL DEFAULT '',
  command_or_url TEXT NOT NULL DEFAULT '',
  run_status TEXT NOT NULL DEFAULT 'stopped',
  active_pid INTEGER
);
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  bot_profile_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  active_model_override_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  compacted_context_capsule TEXT NOT NULL DEFAULT '',
  is_pinned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_steps (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  model_used TEXT NOT NULL DEFAULT '',
  content_markdown TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL,
  action_payload_json TEXT NOT NULL DEFAULT '{}',
  execution_latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  turn_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  scoped_bot_id TEXT,
  file_path_or_uri TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  wikilinks_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  engine_origin TEXT NOT NULL DEFAULT 'mem0_builtin',
  valid_from INTEGER,
  invalid_at INTEGER,
  external_id TEXT NOT NULL DEFAULT '',
  sync_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_engines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  availability TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  scanned_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_routes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  companion_engine_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills_and_mcps (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  item_type TEXT NOT NULL,
  manifest_markdown_or_json TEXT NOT NULL,
  script_path TEXT NOT NULL DEFAULT '',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL DEFAULT 'global',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  version TEXT NOT NULL DEFAULT '1.0.0'
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yaml_source TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  triggers_json TEXT NOT NULL DEFAULT '[]',
  current_status TEXT NOT NULL DEFAULT 'idle',
  paused_at_node_id TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_policies (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_per_tx_usd REAL NOT NULL DEFAULT 5,
  daily_cap_usd REAL NOT NULL DEFAULT 50,
  require_human_approval_above_usd REAL NOT NULL DEFAULT 10,
  max_slippage_bps INTEGER NOT NULL DEFAULT 35,
  whitelisted_json TEXT NOT NULL DEFAULT '[]',
  killswitch_engaged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wallet_balances (
  rail TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  native_amount TEXT NOT NULL,
  native_value REAL NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connected_wallets (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  connection_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  balance_native TEXT NOT NULL DEFAULT '',
  balance_usd REAL NOT NULL DEFAULT 0,
  daily_limit_usd REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  key_mask TEXT NOT NULL DEFAULT '',
  explorer_url TEXT NOT NULL DEFAULT '',
  verified_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  bot_profile_id TEXT,
  bot_handle TEXT NOT NULL DEFAULT '',
  rail TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  native_amount TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  purpose TEXT NOT NULL,
  policy_decision TEXT NOT NULL,
  tx_hash_or_ref TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'agent',
  effect TEXT NOT NULL DEFAULT 'spend',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  symbol TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  pnl_usd REAL NOT NULL,
  open INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS remediation_logs (
  id TEXT PRIMARY KEY,
  tier INTEGER NOT NULL,
  fault_type TEXT NOT NULL,
  target_component TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  recovery_duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'repaired',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_logs (
  id TEXT PRIMARY KEY,
  bot_name TEXT NOT NULL,
  stream TEXT NOT NULL,
  line TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS extensions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  origin TEXT NOT NULL,
  owner_profile_id TEXT NOT NULL DEFAULT '',
  plugin_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  slash_command TEXT NOT NULL DEFAULT '',
  requires_tools_json TEXT NOT NULL DEFAULT '[]',
  platforms_json TEXT NOT NULL DEFAULT '[]',
  body_path TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_identity ON skills(origin, owner_profile_id, plugin_id, slug);
CREATE TABLE IF NOT EXISTS skill_enables (
  skill_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (skill_id, profile_id)
);
CREATE TABLE IF NOT EXISTS skill_proposals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  proposed_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  trust TEXT NOT NULL DEFAULT 'untrusted',
  has_agent INTEGER NOT NULL DEFAULT 0,
  has_desktop INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  desktop_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_agent_enables (
  plugin_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_id, profile_id)
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  trust TEXT NOT NULL DEFAULT 'untrusted',
  tools_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_enables (
  server_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, profile_id)
);
CREATE TABLE IF NOT EXISTS bot_groups (
  id TEXT PRIMARY KEY,
  group_handle TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  coordination_mode TEXT NOT NULL DEFAULT 'autonomous_handoff',
  lead_bot_id TEXT NOT NULL DEFAULT '',
  member_bot_ids_json TEXT NOT NULL,
  shared_workspace_dir TEXT NOT NULL DEFAULT '',
  routine_schedule TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delegation_contracts (
  id TEXT PRIMARY KEY,
  issuer_bot_id TEXT NOT NULL,
  assignee_bot_id TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  scope_label TEXT NOT NULL,
  sub_goal TEXT NOT NULL,
  complexity_score INTEGER NOT NULL,
  routed_endpoint TEXT NOT NULL,
  cost_tier TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  verifier_rule TEXT NOT NULL,
  requires_human INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  commitment TEXT NOT NULL,
  friction_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delegation_reports (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  from_bot_id TEXT NOT NULL,
  to_bot_id TEXT NOT NULL,
  report_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  commitment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_gateway_audit_logs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  tool_or_surface TEXT NOT NULL,
  target_resource TEXT NOT NULL,
  gateway_decision TEXT NOT NULL,
  rule_matched TEXT NOT NULL DEFAULT '',
  recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS harness2_runs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  domain_tag TEXT DEFAULT 'general',
  trigger_mode TEXT NOT NULL,
  recursion_mode TEXT NOT NULL,
  substrate TEXT NOT NULL,
  budget_k INTEGER NOT NULL DEFAULT 1,
  complexity_score INTEGER NOT NULL,
  editor_model TEXT NOT NULL,
  executor_model TEXT NOT NULL,
  modified_components_json TEXT NOT NULL,
  probe_contrasts_json TEXT NOT NULL,
  composed_diff_patch TEXT NOT NULL,
  experience_lesson_md TEXT NOT NULL,
  adopted_into_library INTEGER DEFAULT 0,
  promoted_to_base_profile INTEGER DEFAULT 0,
  shadow_git_commit TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS harness2_library_entries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  domain_tag TEXT NOT NULL,
  component_type TEXT NOT NULL,
  title TEXT NOT NULL,
  when_to_apply_rule TEXT NOT NULL,
  behavioral_evidence TEXT NOT NULL,
  artifact_path_or_content TEXT NOT NULL,
  source_run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_h2_runs_bot ON harness2_runs(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_h2_library_bot ON harness2_library_entries(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_bot ON chat_threads(bot_profile_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_audit ON bot_gateway_audit_logs(bot_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_steps_thread ON execution_steps(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx ON wallet_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_bot ON wallet_transactions(bot_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_remediation ON remediation_logs(tier, created_at DESC);
CREATE TABLE IF NOT EXISTS quant_orders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  pair TEXT NOT NULL,
  analyst TEXT NOT NULL,
  thesis TEXT NOT NULL,
  side TEXT NOT NULL,
  size_usd REAL NOT NULL,
  ws_latency_ms REAL NOT NULL,
  rebate_usd REAL NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  bot_handle TEXT NOT NULL,
  reference TEXT NOT NULL,
  wallet_tx_id TEXT
);
CREATE TABLE IF NOT EXISTS sentinels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  severity TEXT NOT NULL DEFAULT 'info',
  acknowledged INTEGER NOT NULL DEFAULT 0,
  last_scan INTEGER NOT NULL DEFAULT 0,
  finding TEXT NOT NULL DEFAULT '',
  staged_fix TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sentinel_events (
  id TEXT PRIMARY KEY,
  sentinel_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sentinel_events ON sentinel_events(sentinel_id, created_at DESC);
CREATE TABLE IF NOT EXISTS squad_shared_blackboard (
  id TEXT PRIMARY KEY,
  from_bot TEXT NOT NULL,
  to_bot TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_squad_blackboard_created ON squad_shared_blackboard(created_at DESC);
"#;

pub fn drop_reference_fixture(conn: &Connection, home: &Path) -> Result<()> {
    if kv_get(conn, "fixture_cleared")?.as_deref() == Some("1") {
        return Ok(());
    }
    let markers: i64 = conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM chat_threads WHERE id = 'thread_auth')
          + (SELECT COUNT(*) FROM workflows WHERE id = 'wf_market')
          + (SELECT COUNT(*) FROM wallet_transactions WHERE id LIKE 'tx_seed_%')
          + (SELECT COUNT(*) FROM bot_profiles WHERE id IN ('bot_fullstack','bot_quant','bot_grok','bot_muse','bot_dots'))
          + (SELECT COUNT(*) FROM wallet_balances WHERE rail = 'crypto_x402' AND ABS(native_value - 1240.50) < 0.02)",
        [],
        |r| r.get(0),
    )?;
    if markers == 0 {
        kv_set(conn, "fixture_cleared", "1")?;
        return Ok(());
    }
    delete_if_exact(
        &home.join("extensions").join("live-ticker.js"),
        "export function mount(header) {\n  header.addSlot('ticker', { symbols: ['BTC', 'NIFTY'] });\n}\n",
    );
    delete_if_exact(
        &home.join("extensions").join("compact-rail.css"),
        "/* compact-rail.css\n   Tightens the icon rail labels when Pro density is on.\n*/\n",
    );
    delete_if_exact(
        &home.join("extensions").join("skills").join("scraper.js"),
        "export function rows(res) {\n  const rows = res.data.map(parse)\n  return rows\n}\nfunction parse(x) { return x }\n",
    );
    delete_if_exact(
        &home.join("extensions").join("skills").join("SKILL.md"),
        "# /security-audit\nScan the project root. Never print a raw secret.\n",
    );
    delete_if_exact(&home.join("workflows").join("market.workflow.yaml"), &reference_market_yaml());
    clear_workspace_rows(conn)?;
    Ok(())
}

fn delete_if_exact(path: &Path, expected: &str) {
    if std::fs::read_to_string(path).ok().as_deref() == Some(expected) {
        let _ = std::fs::remove_file(path);
    }
}

fn reference_market_yaml() -> String {
    let nodes = vec![
        WfNode { id: "node_1".into(), name: "@Grokbot Scrape".into(), kind: "bot_action".into(), bot_profile: "@Grokbot-Scout".into(), model: "grok-pro-webview".into(), prompt: "Extract the top 5 macro and crypto catalysts from the configured feeds.".into(), status: "done".into(), latency_ms: 180 },
        WfNode { id: "node_2".into(), name: "Obsidian memory".into(), kind: "memory_enrich".into(), bot_profile: "@Quant-Trader".into(), model: "local-memory".into(), prompt: "Pull trading rules and the risk limits note.".into(), status: "done".into(), latency_ms: 14 },
        WfNode { id: "node_3".into(), name: "Analyze and backtest".into(), kind: "llm_reasoning".into(), bot_profile: "@FullStack-Architect".into(), model: "prov_claude".into(), prompt: "Backtest the signal against recent volatility and output a signed trade intent only if it clears the risk note.".into(), status: "paused".into(), latency_ms: 0 },
        WfNode { id: "node_4".into(), name: "Wallet execute".into(), kind: "wallet_execution".into(), bot_profile: "@Quant-Trader".into(), model: "policy-gate".into(), prompt: "Settle the intent on the sandbox x402 rail if policy allows. Amount 0.04 USD.".into(), status: "pending".into(), latency_ms: 0 },
    ];
    let triggers = vec!["cron: 0 8 * * *".to_string(), "telegram: /run_alpha".to_string()];
    crate::yaml_flow::emit("wf_market", "Morning Market Signal", "paused_editable", Some("node_3"), &triggers, &nodes)
}

fn clear_workspace_rows(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM execution_steps;
         DELETE FROM chat_threads;
         DELETE FROM memory_embeddings;
         DELETE FROM memory_events;
         DELETE FROM memory_items;
         DELETE FROM skills_and_mcps;
         DELETE FROM skill_enables;
         DELETE FROM skill_proposals;
         DELETE FROM skills;
         DELETE FROM plugin_agent_enables;
         DELETE FROM plugins;
         DELETE FROM mcp_enables;
         DELETE FROM mcp_servers;
         DELETE FROM bot_groups;
         DELETE FROM bot_gateway_audit_logs;
         DELETE FROM workflows;
         DELETE FROM wallet_transactions;
         DELETE FROM remediation_logs;
         DELETE FROM quant_orders;
         DELETE FROM sentinel_events;
         DELETE FROM fleet_logs;
         DELETE FROM extensions;
         DELETE FROM positions;
         DELETE FROM wallet_balances;
         DELETE FROM wallet_policies;
         DELETE FROM linked_local_apps;
         DELETE FROM bot_profiles;
         DELETE FROM provider_accounts;
         DELETE FROM app_kv WHERE key NOT IN ('vault_salt','vault_verifier','secrets_nonce','secrets_blob');",
    )?;
    Ok(())
}

pub fn seed_if_empty(conn: &Connection, home: &Path) -> Result<()> {
    if kv_get(conn, "bootstrapped")?.as_deref() == Some("1") {
        return Ok(());
    }
    let t = now_ms();
    let providers: [(&str, &str, &str, &str, Option<&str>, &str); 17] = [
        ("prov_claude", "Claude Code", "cli_subprocess", "", Some("prov_anthropic"), "Not installed. Download Claude Code, or use an Anthropic key."),
        ("prov_chatgpt", "ChatGPT", "official_oauth", "https://chatgpt.com", None, "Not signed in. Open the site, or paste an OpenAI API key to chat here."),
        ("prov_anthropic", "Anthropic", "byok_api", "https://api.anthropic.com", None, "Needs an API key."),
        ("prov_gemini", "Gemini", "cli_subprocess", "", None, "Not signed in. Open Gemini, or paste a Google AI key."),
        ("prov_grok", "Grok", "isolated_webview", "https://grok.com", None, "Not signed in. Open grok.com, or paste an xAI API key."),
        ("prov_openrouter", "OpenRouter", "byok_api", "https://openrouter.ai/api/v1", None, "Needs an API key."),
        ("prov_deepseek", "DeepSeek", "byok_api", "https://api.deepseek.com/v1", None, "Needs an API key."),
        ("prov_qwen", "Qwen", "byok_api", "https://dashscope.aliyuncs.com/compatible-mode/v1", None, "Needs an API key."),
        ("prov_tokenrouter", "TokenRouter", "byok_api", "https://api.tokenrouter.io/v1", None, "Needs an API key."),
        ("prov_bedrock", "Bedrock", "byok_api", "https://bedrock-runtime.us-east-1.amazonaws.com", None, "Needs a Bedrock API key."),
        ("prov_nvidia", "NVIDIA NIM", "byok_api", "https://integrate.api.nvidia.com/v1", None, "Needs an NVIDIA API key."),
        ("prov_mistral", "Mistral", "byok_api", "https://api.mistral.ai/v1", None, "Needs a Mistral API key. Le Chat opens from the model menu."),
        ("prov_groq", "Groq", "byok_api", "https://api.groq.com/openai/v1", None, "Needs a Groq API key."),
        ("prov_perplexity", "Perplexity", "byok_api", "https://api.perplexity.ai", None, "Needs a Perplexity API key. The site sign-in stays on perplexity.ai."),
        ("prov_together", "Together", "byok_api", "https://api.together.xyz/v1", None, "Needs a Together API key."),
        ("prov_cohere", "Cohere", "byok_api", "https://api.cohere.com/compatibility/v1", None, "Needs a Cohere API key."),
        ("prov_ollama", "Ollama", "local_ollama", "http://127.0.0.1:11434", None, "Not running. Download Ollama, then test the lane."),
    ];
    for (id, name, kind, endpoint, fallback, detail) in providers {
        conn.execute(
            "INSERT OR IGNORE INTO provider_accounts (id, name, provider_type, binary_or_endpoint, has_secret, quota_window_hours, quota_used_percent, quota_resets_at, fallback_account_id, is_active, allow_cli_dispatch, health_detail, created_at)
             VALUES (?1,?2,?3,?4,0,5,0,'',?5,1,0,?6,?7)",
            params![id, name, kind, endpoint, fallback, detail, t],
        )?;
    }

    let apps = [
        ("app_cursor", "Cursor", "ide_bridge", "ws_companion"),
        ("app_vscode", "VS Code", "ide_bridge", "ws_companion"),
        ("app_obsidian", "Obsidian", "memory_vault", "fs_watcher"),
        ("app_aider", "Aider", "acp_agent", "acp_stdio"),
        ("app_opencode", "OpenCode", "acp_agent", "acp_stdio"),
        ("app_claude", "Claude Code", "acp_agent", "acp_stdio"),
        ("app_codex", "Codex CLI", "acp_agent", "acp_stdio"),
        ("app_gemini", "Gemini CLI", "acp_agent", "acp_stdio"),
        ("app_grokbot", "Grokbot", "bot_daemon", "uv_daemon"),
        ("app_muse", "Muse", "bot_daemon", "uv_daemon"),
        ("app_dots", "Dots", "bot_daemon", "uv_daemon"),
    ];
    for (id, name, cat, proto) in apps {
        conn.execute(
            "INSERT INTO linked_local_apps (id, app_name, category, executable_path, bridge_protocol, status, detail, updated_at) VALUES (?1,?2,?3,'',?4,'missing','Not found yet. Scan this computer.',?5)",
            params![id, name, cat, proto, t],
        )?;
    }



    let _ = std::fs::create_dir_all(home.join("workflows"));
    let _ = std::fs::create_dir_all(home.join("extensions").join("skills"));
    let _ = std::fs::create_dir_all(home.join("sandbox"));

    conn.execute(
        "INSERT OR IGNORE INTO wallet_policies (id, max_per_tx_usd, daily_cap_usd, require_human_approval_above_usd, max_slippage_bps, whitelisted_json, killswitch_engaged) VALUES (1, 5, 50, 5, 35, '[]', 0)",
        [],
    )?;
    for (rail, label, native, detail) in [
        ("crypto_x402", "Crypto & x402", "0.00 USDC", "Sandbox ledger. No exchange is connected."),
        ("razorpay_upi", "Razorpay India", "₹0", "Sandbox ledger. No payout account is connected."),
        ("stripe_card", "Stripe virtual card", "No card", "Sandbox ledger. No card is connected."),
        ("hyperliquid_ws", "Hyperliquid L1 margin", "0.00 USDC", "Sandbox ledger. Quant rail over wss://api.hyperliquid.xyz/ws."),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO wallet_balances (rail, label, amount_usd, native_amount, native_value, detail) VALUES (?1,?2,0,?3,0,?4)",
            params![rail, label, native, detail],
        )?;
    }
    let mut settings = Settings::default();
    if let Ok(cwd) = std::env::current_dir() {
        settings.project_root = cwd.display().to_string();
    }
    kv_set(conn, "settings", &serde_json::to_string(&settings)?)?;
    kv_set(conn, "onboarding_complete", "0")?;
    kv_set(conn, "computer_url", "")?;
    kv_set(conn, "quote_btc", "—")?;
    kv_set(conn, "quote_nifty", "—")?;
    kv_set(conn, "bootstrapped", "1")?;
    kv_set(conn, "fixture_cleared", "1")?;
    Ok(())
}

pub fn reset_workspace(conn: &Connection, home: &Path) -> Result<()> {
    clear_workspace_rows(conn)?;
    for rel in ["profiles", "catalog", "plugins", "mcp"] {
        let _ = std::fs::remove_dir_all(home.join(rel));
    }
    seed_if_empty(conn, home)?;
    ensure_default_profile(conn)
}

/// A workspace needs at least one bot profile: skill enables, the memory
/// prompt, and the mesh all bind to the active profile. A reset (or a fresh
/// database) can leave none, which shows every skill as off.
pub fn ensure_default_profile(conn: &Connection) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let t = now_ms();
    conn.execute(
        "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at, status_line) VALUES ('bot_default','@assistant','Assistant','mark:orb','Finish the task in front of you. Use the workspace tools when they help, and say clearly what you did.','prov_ollama','prov_gemini','prov_openrouter',1,1,1,'',5,1,'General assistant that handles tasks end to end',?1,'Ready for tasks')",
        params![t],
    )?;
    if kv_get(conn, "active_profile")?.as_deref().unwrap_or("").trim().is_empty() {
        kv_set(conn, "active_profile", "bot_default")?;
    }
    Ok(())
}

pub fn kv_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM app_kv WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn kv_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn settings_of(conn: &Connection) -> Result<Settings> {
    match kv_get(conn, "settings")? {
        Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        None => Ok(Settings::default()),
    }
}

pub fn save_settings(conn: &Connection, settings: &Settings) -> Result<()> {
    kv_set(conn, "settings", &serde_json::to_string(settings)?)
}

pub fn log_repair(conn: &Connection, tier: i64, fault: &str, target: &str, action: &str, ms: i64, status: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO remediation_logs (id, tier, fault_type, target_component, action_taken, recovery_duration_ms, status, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![nid("rem"), tier, fault, target, action, ms, status, now_ms()],
    )?;
    Ok(())
}

pub fn insert_step(conn: &Connection, thread_id: &str, role: &str, model: &str, content: &str, action: &str, payload: &Value, latency: i64) -> Result<()> {
    insert_step_in(conn, thread_id, "", role, model, content, action, payload, latency)
}

/// Live-activity step: a tiny `turn_activity` row the snapshot poll can see
/// while the model turn is still running. The UI renders it in very small
/// letters inside the working pill. Stale rows (a turn that ended without
/// finishing cleanly) are swept after a minute.
pub fn record_turn_activity(conn: &Connection, thread_id: &str, turn_id: &str, detail: &str) -> Result<()> {
    let now = now_ms();
    // One sweep clears this thread's prior marker plus any stale rows left by
    // turns that ended without finishing cleanly (60s grace).
    conn.execute(
        "DELETE FROM execution_steps WHERE action_type = 'turn_activity' AND (thread_id = ?1 OR created_at < ?2)",
        params![thread_id, now - 60_000],
    )?;
    // model_used='activity' keeps the row distinguishable from a real tool step
    // for any consumer that forgets to filter on action_type.
    conn.execute(
        "INSERT INTO execution_steps (id, thread_id, turn_id, role, model_used, content_markdown, action_type, action_payload_json, execution_latency_ms, created_at) VALUES (?1,?2,?3,'tool','activity',?4,'turn_activity',?5,0,?6)",
        params![nid("act"), thread_id, turn_id, detail, json!({"detail": detail}).to_string(), now],
    )?;
    Ok(())
}

pub fn insert_step_in(conn: &Connection, thread_id: &str, turn_id: &str, role: &str, model: &str, content: &str, action: &str, payload: &Value, latency: i64) -> Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO execution_steps (id, thread_id, turn_id, role, model_used, content_markdown, action_type, action_payload_json, execution_latency_ms, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![nid("step"), thread_id, turn_id, role, model, content, action, payload.to_string(), latency, now],
    )?;
    conn.execute("UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2", params![now, thread_id])?;
    Ok(())
}

pub fn spent_today(conn: &Connection) -> Result<f64> {
    spent_today_since(conn, now_ms() - 86_400_000, None)
}

pub fn spent_today_for_bot(conn: &Connection, bot_id: &str) -> Result<f64> {
    spent_today_since(conn, now_ms() - 86_400_000, Some(bot_id))
}

fn spent_today_since(conn: &Connection, start: i64, bot_id: Option<&str>) -> Result<f64> {
    let v: f64 = if let Some(bot_id) = bot_id {
        conn.query_row(
            "SELECT COALESCE(SUM(amount_usd),0) FROM wallet_transactions WHERE actor = 'agent' AND effect = 'spend' AND policy_decision IN ('auto_signed_by_rust','approved_by_user') AND created_at >= ?1 AND bot_profile_id = ?2",
            params![start, bot_id],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COALESCE(SUM(amount_usd),0) FROM wallet_transactions WHERE actor = 'agent' AND effect = 'spend' AND policy_decision IN ('auto_signed_by_rust','approved_by_user') AND created_at >= ?1",
            params![start],
            |r| r.get(0),
        )?
    };
    Ok(v)
}

pub fn load_policy(conn: &Connection) -> Result<Policy> {
    conn.query_row(
        "SELECT max_per_tx_usd, daily_cap_usd, require_human_approval_above_usd, max_slippage_bps, killswitch_engaged, whitelisted_json FROM wallet_policies WHERE id = 1",
        [],
        |r| {
            let raw: String = r.get(5)?;
            let whitelisted = serde_json::from_str(&raw).unwrap_or_default();
            Ok(Policy {
                max_per_tx_usd: r.get(0)?,
                daily_cap_usd: r.get(1)?,
                require_human_approval_above_usd: r.get(2)?,
                max_slippage_bps: r.get(3)?,
                killswitch_engaged: r.get::<_, i64>(4)? != 0,
                whitelisted,
            })
        },
    )
    .map_err(Into::into)
}

pub fn checkpoint(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    Ok(())
}

pub fn parse_json_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

pub fn require_thread(conn: &Connection, id: &str) -> Result<()> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM chat_threads WHERE id = ?1", params![id], |r| r.get(0))?;
    if n == 0 {
        Err(err("thread not found"))
    } else {
        Ok(())
    }
}
