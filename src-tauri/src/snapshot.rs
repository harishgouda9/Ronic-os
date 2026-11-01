use crate::db::{self, parse_json_value};
use crate::error::Result;
use crate::models::*;
use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

pub struct Meta {
    pub home: String,
    pub heartbeat_ms: u64,
    pub proxy_port: u16,
    pub ipc: Vec<String>,
    pub unlocked: bool,
}

pub fn load(conn: &Connection, meta: &Meta) -> Result<Snapshot> {
    let settings = db::settings_of(conn)?;
    crate::capabilities::reconcile_if_due(conn, Path::new(&meta.home), &settings.project_root)?;
    let mut profiles = profiles(conn)?;
    for profile in &mut profiles {
        crate::bots::ensure_computer(conn, Path::new(&meta.home), profile)?;
    }
    let threads = threads(conn)?;
    let active_profile = db::kv_get(conn, "active_profile")?.unwrap_or_else(|| profiles.first().map(|p| p.id.clone()).unwrap_or_default());
    let active_thread = db::kv_get(conn, "active_thread")?.filter(|id| !id.is_empty());
    let steps = match &active_thread {
        Some(id) => steps_for(conn, id)?,
        None => Vec::new(),
    };
    let caps = crate::capabilities::view(conn, Path::new(&meta.home), &active_profile)?;
    let delegation = crate::chief_delegation::load_view(conn)?;
    let mut market = catalog();
    for item in &mut market {
        let clean_slug = item.slug.trim_start_matches('/');
        item.installed = caps.skills.iter().any(|skill| skill.slug.trim_start_matches('/') == clean_slug)
            || caps.mcp_servers.iter().any(|mcp| mcp.id == item.slug || mcp.name.eq_ignore_ascii_case(&item.title))
            || caps.plugins.iter().any(|plug| plug.slug == clean_slug || plug.name.eq_ignore_ascii_case(&item.title));
    }
    let beat = meta.heartbeat_ms as i64;
    let age = if beat == 0 { 0 } else { (now_ms() - beat).max(0) };
    let port = meta.proxy_port;
    let dom_nodes = db::kv_get(conn, "dom_nodes")?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let dom_latency_ms = db::kv_get(conn, "dom_latency_ms")?.and_then(|s| s.parse().ok()).unwrap_or(0);
    let turn_activity: String = match &active_thread {
        Some(id) => conn
            .query_row(
                "SELECT content_markdown FROM execution_steps WHERE thread_id = ?1 AND action_type = 'turn_activity' AND created_at >= ?2 ORDER BY created_at DESC LIMIT 1",
                params![id, now_ms() - 60_000],
                |r| r.get(0),
            )
            .unwrap_or_default(),
        None => String::new(),
    };
    Ok(Snapshot {
        home_dir: meta.home.clone(),
        onboarding_complete: db::kv_get(conn, "onboarding_complete")?.as_deref() == Some("1"),
        vault_unlocked: meta.unlocked,
        has_passphrase: db::kv_get(conn, "vault_verifier")?.is_some(),
        sandbox: !settings.live_rails,
        kernel: "rust".into(),
        active_profile_id: active_profile,
        active_thread_id: active_thread,
        turn_activity,
        profiles,
        threads,
        steps,
        bot_groups: bot_groups(conn)?,
        chief_bot_id: delegation.0,
        delegation_contracts: delegation.1,
        delegation_reports: delegation.2,
        gateway_audits: gateway_audits(conn)?,
        providers: providers(conn)?,
        apps: apps(conn)?,
        memories: memories(conn)?,
        memory_engines: memory_engines(conn)?,
        memory_route: memory_route(conn)?,
        memory_routes: memory_routes(conn)?,
        skills: caps.skills,
        plugins: caps.plugins,
        mcp_servers: caps.mcp_servers,
        skill_proposals: caps.proposals,
        registry: caps.registry,
        skill_index_delta: caps.skill_index_delta,
        workflows: workflows(conn)?,
        policy: db::load_policy(conn)?,
        balances: balances(conn)?,
        connected_wallets: crate::wallet_live::list(conn)?,
        wallet_pin_set: crate::wallet_live::pin_is_set(conn),
        transactions: transactions(conn)?,
        positions: positions(conn)?,
        quant_orders: quant_orders(conn)?,
        bot_allowances: crate::wallet_engine::bot_allowances(conn)?,
        ledger_mode: crate::wallet_engine::ledger_mode(conn),
        sentinels: crate::remediation_core::sentinels(conn)?,
        sentinel_events: crate::remediation_core::sentinel_events(conn)?,
        tier_status: crate::remediation_core::tier_status(conn, Path::new(&meta.home), meta.heartbeat_ms)?,
        remediation: remediation(conn)?,
        shadow_backups: crate::remediation_core::shadow_backups(Path::new(&meta.home))?,
        processes: processes(conn, port)?,
        fleet_logs: fleet_logs(conn)?,
        extensions: extensions(conn)?,
        marketplace: market,
        settings,
        scan: db::kv_get(conn, "last_scan")?.and_then(|s| serde_json::from_str(&s).ok()),
        proxy_url: if port == 0 { "http://127.0.0.1:4141/v1".into() } else { format!("http://127.0.0.1:{port}/v1") },
        heartbeat_age_ms: age,
        ipc_log: meta.ipc.clone(),
        quote_btc: db::kv_get(conn, "quote_btc")?.unwrap_or_else(|| "—".into()),
        quote_nifty: db::kv_get(conn, "quote_nifty")?.unwrap_or_else(|| "—".into()),
        spent_today_usd: db::spent_today(conn)?,
        ide_agent: db::kv_get(conn, "ide_agent")?.unwrap_or_default(),
        computer_url: db::kv_get(conn, "computer_url")?.unwrap_or_default(),
        dom_nodes,
        dom_latency_ms,
        sandbox_output: db::kv_get(conn, "sandbox_output")?.unwrap_or_default(),
        bug_preview: db::kv_get(conn, "bug_preview")?.unwrap_or_default(),
        license: crate::licensing::load_snapshot(conn),
    })
}

fn flag(v: i64) -> bool {
    v != 0
}

fn profiles(conn: &Connection) -> Result<Vec<BotProfile>> {
    let mut stmt = conn.prepare("SELECT id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, engine, command_or_url, run_status, active_pid, status_line, harness_lane_id, ag_ui_endpoint_url, browser_partition, workspace_dir, allow_file_write, require_approval_external, require_approval_wallet, stall_timeout_ms, avatar_color, engine_kind, api_base, api_model, COALESCE(wallet_frozen, 0), approval_mode FROM bot_profiles ORDER BY is_pinned DESC, handle")?;
    let rows = stmt.query_map([], |r| {
        Ok(BotProfile {
            id: r.get(0)?,
            handle: r.get(1)?,
            display_name: r.get(2)?,
            avatar: r.get(3)?,
            soul_markdown: r.get(4)?,
            primary_account_id: r.get(5)?,
            long_context_account_id: r.get(6)?,
            fallback_account_id: r.get(7)?,
            allow_computer_use: flag(r.get(8)?),
            allow_browser_use: flag(r.get(9)?),
            allow_code_exec: flag(r.get(10)?),
            scoped_obsidian_folder: r.get(11)?,
            daily_wallet_limit_usd: r.get(12)?,
            is_pinned: flag(r.get(13)?),
            role: r.get(14)?,
            engine: r.get(15)?,
            command_or_url: r.get(16)?,
            run_status: r.get(17)?,
            active_pid: r.get(18)?,
            status_line: r.get(19)?,
            harness_lane_id: r.get(20)?,
            ag_ui_endpoint_url: r.get(21)?,
            browser_partition: r.get(22)?,
            workspace_dir: r.get(23)?,
            allow_file_write: flag(r.get(24)?),
            require_approval_external: flag(r.get(25)?),
            require_approval_wallet: flag(r.get(26)?),
            stall_timeout_ms: r.get(27)?,
            avatar_color: r.get(28)?,
            engine_kind: r.get(29)?,
            api_base: r.get(30)?,
            api_model: r.get(31)?,
            wallet_frozen: flag(r.get(32)?),
            approval_mode: r.get(33)?,
            workspace_files: Vec::new(),
            takeover: false,
            screen_url: String::new(),
            screen_nodes: Vec::new(),
            screen_ms: 0,
            shell_output: String::new(),
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn threads(conn: &Connection) -> Result<Vec<ChatThread>> {
    let mut stmt = conn.prepare("SELECT id, bot_profile_id, title, active_model_override_id, status, compacted_context_capsule, is_pinned, updated_at, target_type, group_id, routine_schedule FROM chat_threads ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |r| {
        Ok(ChatThread {
            id: r.get(0)?,
            bot_profile_id: r.get(1)?,
            title: r.get(2)?,
            active_model_override_id: r.get(3)?,
            status: r.get(4)?,
            compacted_context_capsule: r.get(5)?,
            is_pinned: flag(r.get(6)?),
            updated_at: r.get(7)?,
            target_type: r.get(8)?,
            group_id: r.get(9)?,
            routine_schedule: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn bot_groups(conn: &Connection) -> Result<Vec<crate::models::BotGroup>> {
    let mut stmt = conn.prepare("SELECT id, group_handle, title, purpose, coordination_mode, lead_bot_id, member_bot_ids_json, shared_workspace_dir, routine_schedule, created_at FROM bot_groups ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |r| {
        let raw: String = r.get(6)?;
        Ok(crate::models::BotGroup {
            id: r.get(0)?,
            group_handle: r.get(1)?,
            title: r.get(2)?,
            purpose: r.get(3)?,
            coordination_mode: r.get(4)?,
            lead_bot_id: r.get(5)?,
            member_bot_ids: serde_json::from_str(&raw).unwrap_or_default(),
            shared_workspace_dir: r.get(7)?,
            routine_schedule: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn gateway_audits(conn: &Connection) -> Result<Vec<crate::models::GatewayAudit>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.bot_id, COALESCE(p.handle, ''), a.conversation_id, a.tool_or_surface, a.target_resource, a.gateway_decision, a.rule_matched, a.recorded_at FROM bot_gateway_audit_logs a LEFT JOIN bot_profiles p ON p.id = a.bot_id ORDER BY a.recorded_at DESC LIMIT 40",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(crate::models::GatewayAudit {
            id: r.get(0)?,
            bot_id: r.get(1)?,
            bot_handle: r.get(2)?,
            conversation_id: r.get(3)?,
            tool_or_surface: r.get(4)?,
            target_resource: r.get(5)?,
            gateway_decision: r.get(6)?,
            rule_matched: r.get(7)?,
            recorded_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn steps_for(conn: &Connection, thread_id: &str) -> Result<Vec<Step>> {
    let mut stmt = conn.prepare("SELECT id, thread_id, turn_id, role, model_used, content_markdown, action_type, action_payload_json, execution_latency_ms, created_at FROM execution_steps WHERE thread_id = ?1 ORDER BY created_at ASC")?;
    let rows = stmt.query_map(params![thread_id], |r| {
        let raw: String = r.get(7)?;
        Ok(Step {
            id: r.get(0)?,
            thread_id: r.get(1)?,
            turn_id: r.get(2)?,
            role: r.get(3)?,
            model_used: r.get(4)?,
            content_markdown: r.get(5)?,
            action_type: r.get(6)?,
            action_payload: parse_json_value(&raw),
            execution_latency_ms: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn providers(conn: &Connection) -> Result<Vec<Provider>> {
    let mut stmt = conn.prepare("SELECT id, name, provider_type, binary_or_endpoint, has_secret, quota_window_hours, quota_used_percent, quota_resets_at, fallback_account_id, is_active, allow_cli_dispatch, last_health_check_ms, health_detail FROM provider_accounts ORDER BY created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(Provider {
            id: r.get(0)?,
            name: r.get(1)?,
            provider_type: r.get(2)?,
            binary_or_endpoint: r.get(3)?,
            has_secret: flag(r.get(4)?),
            quota_window_hours: r.get(5)?,
            quota_used_percent: r.get(6)?,
            quota_resets_at: r.get(7)?,
            fallback_account_id: r.get(8)?,
            is_active: flag(r.get(9)?),
            allow_cli_dispatch: flag(r.get(10)?),
            last_health_check_ms: r.get(11)?,
            health_detail: r.get(12)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn apps(conn: &Connection) -> Result<Vec<LinkedApp>> {
    let mut stmt = conn.prepare("SELECT id, app_name, category, executable_path, bridge_protocol, active_pid, local_port, status, detail FROM linked_local_apps ORDER BY app_name")?;
    let rows = stmt.query_map([], |r| {
        Ok(LinkedApp {
            id: r.get(0)?,
            app_name: r.get(1)?,
            category: r.get(2)?,
            executable_path: r.get(3)?,
            bridge_protocol: r.get(4)?,
            active_pid: r.get(5)?,
            local_port: r.get(6)?,
            status: r.get(7)?,
            detail: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn memories(conn: &Connection) -> Result<Vec<MemoryItem>> {
    let mut stmt = conn.prepare("SELECT id, source_type, scoped_bot_id, file_path_or_uri, title, content_markdown, wikilinks_json, updated_at, engine_origin, sync_json, valid_from, invalid_at FROM memory_items ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |r| {
        let raw: String = r.get(6)?;
        Ok(MemoryItem {
            id: r.get(0)?,
            source_type: r.get(1)?,
            scoped_bot_id: r.get(2)?,
            file_path_or_uri: r.get(3)?,
            title: r.get(4)?,
            content_markdown: r.get(5)?,
            wikilinks: serde_json::from_str(&raw).unwrap_or_default(),
            updated_at: r.get(7)?,
            engine_origin: r.get(8)?,
            synced_engines: synced_memory_engines(&r.get::<_, String>(9)?),
            valid_from: r.get(10)?,
            invalid_at: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn synced_memory_engines(raw: &str) -> Vec<String> {
    let mut engines = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .map(|entries| entries.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    engines.sort();
    engines
}

fn memory_engines(conn: &Connection) -> Result<Vec<MemoryEngine>> {
    let mut stmt = conn.prepare("SELECT id, label, kind, availability, endpoint, detail, latency_ms, scanned_at FROM memory_engines ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        Ok(MemoryEngine {
            id: r.get(0)?,
            label: r.get(1)?,
            kind: r.get(2)?,
            availability: r.get(3)?,
            endpoint: r.get(4)?,
            detail: r.get(5)?,
            latency_ms: r.get(6)?,
            scanned_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn memory_routes(conn: &Connection) -> Result<Vec<MemoryRoute>> {
    let mut stmt = conn.prepare("SELECT id, scope, engine_id, companion_engine_id, updated_at FROM memory_routes ORDER BY scope, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(MemoryRoute {
            id: r.get(0)?,
            scope: r.get(1)?,
            engine_id: r.get(2)?,
            companion_engine_id: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn memory_route(conn: &Connection) -> Result<MemoryRoute> {
    let routes = memory_routes(conn)?;
    Ok(routes.into_iter().find(|route| route.id == "global").unwrap_or(MemoryRoute {
        id: "global".into(),
        scope: "global".into(),
        engine_id: "mem0_builtin".into(),
        companion_engine_id: None,
        updated_at: 0,
    }))
}

fn workflows(conn: &Connection) -> Result<Vec<Workflow>> {
    let mut stmt = conn.prepare("SELECT id, name, yaml_source, nodes_json, triggers_json, current_status, paused_at_node_id, checkpoint_json, updated_at FROM workflows ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |r| {
        let nodes_raw: String = r.get(3)?;
        let triggers_raw: String = r.get(4)?;
        let checkpoint_raw: String = r.get(7)?;
        let checkpoint = serde_json::from_str::<Value>(&checkpoint_raw).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        Ok(Workflow {
            id: r.get(0)?,
            name: r.get(1)?,
            yaml_source: r.get(2)?,
            nodes: serde_json::from_str(&nodes_raw).unwrap_or_default(),
            triggers: serde_json::from_str(&triggers_raw).unwrap_or_default(),
            current_status: r.get(5)?,
            paused_at_node_id: r.get(6)?,
            checkpoint,
            updated_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn balances(conn: &Connection) -> Result<Vec<Balance>> {
    let mut stmt = conn.prepare("SELECT rail, label, amount_usd, native_amount, native_value, detail FROM wallet_balances")?;
    let rows = stmt.query_map([], |r| {
        Ok(Balance { rail: r.get(0)?, label: r.get(1)?, amount_usd: r.get(2)?, native_amount: r.get(3)?, native_value: r.get(4)?, detail: r.get(5)? })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn transactions(conn: &Connection) -> Result<Vec<WalletTx>> {
    let mut stmt = conn.prepare("SELECT id, bot_profile_id, bot_handle, rail, amount_usd, native_amount, counterparty, purpose, policy_decision, tx_hash_or_ref, created_at, actor, effect FROM wallet_transactions ORDER BY created_at DESC LIMIT 80")?;
    let rows = stmt.query_map([], |r| {
        Ok(WalletTx {
            id: r.get(0)?,
            bot_profile_id: r.get(1)?,
            bot_handle: r.get(2)?,
            rail: r.get(3)?,
            amount_usd: r.get(4)?,
            native_amount: r.get(5)?,
            counterparty: r.get(6)?,
            purpose: r.get(7)?,
            policy_decision: r.get(8)?,
            tx_hash_or_ref: r.get(9)?,
            created_at: r.get(10)?,
            actor: r.get(11)?,
            effect: r.get(12)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn positions(conn: &Connection) -> Result<Vec<Position>> {
    let mut stmt = conn.prepare("SELECT symbol, venue, side, pnl_usd, open FROM positions")?;
    let rows = stmt.query_map([], |r| Ok(Position { symbol: r.get(0)?, venue: r.get(1)?, side: r.get(2)?, pnl_usd: r.get(3)?, open: flag(r.get(4)?) }))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn quant_orders(conn: &Connection) -> Result<Vec<QuantOrder>> {
    let mut stmt = conn.prepare("SELECT id, created_at, pair, analyst, thesis, side, size_usd, ws_latency_ms, rebate_usd, status, mode, bot_handle, reference FROM quant_orders ORDER BY created_at DESC LIMIT 50")?;
    let rows = stmt.query_map([], |r| {
        Ok(QuantOrder {
            id: r.get(0)?,
            created_at: r.get(1)?,
            pair: r.get(2)?,
            analyst: r.get(3)?,
            thesis: r.get(4)?,
            side: r.get(5)?,
            size_usd: r.get(6)?,
            ws_latency_ms: r.get(7)?,
            rebate_usd: r.get(8)?,
            status: r.get(9)?,
            mode: r.get(10)?,
            bot_handle: r.get(11)?,
            reference: r.get(12)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn remediation(conn: &Connection) -> Result<Vec<Remediation>> {
    let mut stmt = conn.prepare("SELECT id, tier, fault_type, target_component, action_taken, recovery_duration_ms, status, created_at FROM remediation_logs ORDER BY created_at DESC LIMIT 40")?;
    let rows = stmt.query_map([], |r| {
        Ok(Remediation { id: r.get(0)?, tier: r.get(1)?, fault_type: r.get(2)?, target_component: r.get(3)?, action_taken: r.get(4)?, recovery_duration_ms: r.get(5)?, status: r.get(6)?, created_at: r.get(7)? })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn fleet_logs(conn: &Connection) -> Result<Vec<FleetLog>> {
    let mut stmt = conn.prepare("SELECT id, bot_name, stream, line, created_at FROM fleet_logs ORDER BY created_at DESC LIMIT 40")?;
    let rows = stmt.query_map([], |r| Ok(FleetLog { id: r.get(0)?, bot_name: r.get(1)?, stream: r.get(2)?, line: r.get(3)?, created_at: r.get(4)? }))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn extensions(conn: &Connection) -> Result<Vec<Extension>> {
    let mut stmt = conn.prepare("SELECT id, name, path, enabled, code FROM extensions ORDER BY name")?;
    let rows = stmt.query_map([], |r| Ok(Extension { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, enabled: flag(r.get(3)?), code: r.get(4)? }))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn processes(conn: &Connection, port: u16) -> Result<Vec<ProcessRow>> {
    let mut rows = vec![
        ProcessRow { name: "watchdog".into(), pid: Some(std::process::id() as i64), detail: "500ms heartbeat & WAL guard".into(), health: "alive".into() },
        ProcessRow { name: "loopback-proxy".into(), pid: None, detail: format!("127.0.0.1:{port}/v1 (OpenAI-Compatible Multiplexer)"), health: if port == 0 { "starting".into() } else { "listening".into() } },
    ];
    let mut stmt = conn.prepare("SELECT app_name, active_pid, status, executable_path FROM linked_local_apps WHERE (active_pid IS NOT NULL OR status = 'running') AND category NOT IN ('ide_bridge', 'ide', 'memory_vault') AND app_name NOT IN ('Cursor', 'VS Code', 'VS Code Insiders', 'Obsidian')")?;
    let extra = stmt.query_map([], |r| {
        let name: String = r.get(0)?;
        let pid: Option<i64> = r.get(1)?;
        let status: String = r.get(2)?;
        let path: String = r.get(3)?;
        Ok(ProcessRow { name, pid, detail: path, health: status })
    })?;
    for row in extra {
        rows.push(row?);
    }
    Ok(rows)
}
