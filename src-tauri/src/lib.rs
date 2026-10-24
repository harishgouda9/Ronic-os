mod agent;
mod bot_screen;
mod bots;
mod capabilities;
mod commands;
mod computer;
mod db;
mod embed;
mod error;
mod memory;
mod models;
mod policy;
mod proxy;
mod redact;
mod repair;
mod scan;
mod site_window;
mod siwc;
mod snapshot;
mod textutil;
mod util;
mod vault;
mod wallet;
mod workspace_apps;
mod workspace_bridge;
mod workspace_git;
mod yaml_flow;
mod terminal_pty;
pub mod bot_fleet;
mod code_mode;
mod harness2_engine;
mod mcp_acp_automesh;
pub mod tunnel;

use crate::util::{ipc_push, now_ms, product_home};
use rusqlite::Connection;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub home: PathBuf,
    pub heartbeat: Arc<AtomicU64>,
    pub proxy_port: Arc<AtomicU16>,
    pub ipc: Arc<Mutex<VecDeque<String>>>,
    pub unlocked: Arc<AtomicBool>,
    pub secrets: Mutex<HashMap<String, String>>,
    pub vault_key: Mutex<Option<[u8; 32]>>,
    pub app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

pub fn run() {
    clear_stale_instances();
    let home = product_home();
    let _ = std::fs::create_dir_all(home.join("extensions").join("skills"));
    let _ = std::fs::create_dir_all(home.join("workflows"));
    let _ = std::fs::create_dir_all(home.join("sandbox"));
    let _ = std::fs::create_dir_all(home.join(".shadow-git"));
    let _ = std::fs::create_dir_all(home.join("tickets"));
    let db_path = home.join("state.db");
    let conn = db::open(&db_path).expect("open state.db");
    db::migrate(&conn).expect("migrate");
    db::drop_reference_fixture(&conn, &home).expect("clear reference fixture");
    db::seed_if_empty(&conn, &home).expect("seed");
    db::ensure_default_profile(&conn).expect("default profile");
    let has_pass = db::kv_get(&conn, "vault_verifier").ok().flatten().is_some();
    let secrets = if has_pass { HashMap::new() } else { vault::load_plaintext(&home) };
    let heartbeat = Arc::new(AtomicU64::new(now_ms() as u64));
    let proxy_port = Arc::new(AtomicU16::new(0));
    let ipc = Arc::new(Mutex::new(VecDeque::new()));
    proxy::spawn(proxy_port.clone(), ipc.clone());
    spawn_watchdog(db_path.clone(), heartbeat.clone());
    ipc_push(&ipc, "kernel started");
    let state = AppState {
        conn: Mutex::new(conn),
        home,
        heartbeat,
        proxy_port,
        ipc,
        unlocked: Arc::new(AtomicBool::new(!has_pass)),
        secrets: Mutex::new(secrets),
        vault_key: Mutex::new(None),
        app_handle: Arc::new(Mutex::new(None)),
    };
    tauri::Builder::default()
        .manage(state)
        .manage(terminal_pty::TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::scan_environment,
            commands::complete_onboarding,
            commands::link_apps,
            commands::switch_profile,
            commands::select_thread,
            commands::create_thread,
            commands::send_message,
            commands::set_thread_model,
            commands::set_diff_status,
            commands::save_profile,
            commands::create_profile,
            commands::duplicate_profile,
            commands::create_bot_group,
            commands::open_group,
            commands::set_group_mode,
            commands::set_routine,
            commands::run_routine,
            commands::resolve_gateway,
            commands::teach_task,
            commands::set_takeover,
            commands::update_provider,
            commands::add_provider,
            commands::set_provider_secret,
            commands::sign_in_chatgpt,
            commands::list_provider_models,
            commands::test_provider,
            commands::save_memory,
            commands::delete_memory,
            commands::scan_memory_engines,
            commands::set_memory_route,
            commands::mount_memory_companion,
            commands::unmount_memory_companion,
            commands::sync_memories_to_engine,
            commands::refresh_memory_vault,
            commands::save_skill,
            commands::toggle_skill,
            commands::remove_skill,
            commands::load_skill,
            commands::propose_skill,
            commands::resolve_skill_proposal,
            commands::save_plugin,
            commands::toggle_plugin_agent,
            commands::toggle_plugin_desktop,
            commands::trust_plugin,
            commands::remove_plugin,
            commands::save_mcp,
            commands::toggle_mcp,
            commands::trust_mcp,
            commands::remove_mcp,
            commands::scan_project_plugins,
            commands::install_market,
            commands::set_policy,
            commands::wallet_tx,
            commands::review_tx,
            commands::refresh_workspace,
            commands::run_repair,
            commands::preview_bug,
            commands::submit_bug,
            commands::save_settings,
            commands::set_vault_passphrase,
            commands::unlock_vault,
            commands::lock_vault,
            commands::save_extension,
            commands::toggle_extension,
            commands::generate_extension,
            commands::open_provider_window,
            commands::pick_paths,
            commands::connect_external_bot,
            commands::set_bot_run,
            commands::set_app_path,
            commands::add_app,
            commands::fleet_action,
            commands::inspect_url,
            commands::run_sandbox,
            commands::memory_vault,
            commands::workspace_git,
            commands::install_git_package,
            commands::create_workflow,
            commands::update_workflow,
            commands::pause_workflow,
            commands::resume_workflow,
            commands::run_workflow,
            commands::set_ide_agent,
            commands::close_position,
            commands::reset_workspace,
            commands::scan_all_harnesses,
            commands::open_harness_window,
            commands::launch_local_app,
            commands::run_harness_prompt,
            commands::installed_webapps,
            commands::show_workspace_webapp,
            commands::place_workspace_webapp,
            commands::hide_workspace_webapps,
            commands::show_page_browser,
            commands::place_page_browser,
            commands::hide_page_browser,
            commands::page_browser_go,
            commands::show_bot_screen,
            commands::reveal_bot_screen,
            commands::place_bot_screen,
            commands::hide_bot_screens,
            commands::launch_desktop_app,
            commands::workspace_bridge_status,
            terminal_pty::spawn_terminal,
            terminal_pty::write_terminal,
            terminal_pty::resize_terminal,
            terminal_pty::close_terminal,
            bot_fleet::get_fleet_status,
            bot_fleet::start_fleet_daemon,
            bot_fleet::stop_fleet_daemon,
            bot_fleet::restart_fleet_daemon,
            bot_fleet::toggle_fleet_ghost_runner,
            bot_fleet::run_fleet_routine,
            bot_fleet::send_fleet_daemon_input,
            bot_fleet::clear_fleet_logs,
            mcp_acp_automesh::mesh_status,
            mcp_acp_automesh::mesh_connect_all,
            mcp_acp_automesh::mesh_set_flags,
            mcp_acp_automesh::mesh_relay,
            mcp_acp_automesh::open_mcp_connected_webapp,
            mcp_acp_automesh::open_harness_mcp_setup,
            mcp_acp_automesh::get_webapp_mcp_context_bundle,
            mcp_acp_automesh::omni_ask_peer_app,
            tunnel::mesh_tunnel_status,
            tunnel::mesh_tunnel_start,
            tunnel::mesh_tunnel_stop,
            tunnel::mesh_tunnel_download,
            code_mode::compile_mcp_acp_to_typescript_dts,
            code_mode::execute_code_mode_script,
            code_mode::omni_search_capabilities,
            harness2_engine::harness2_status,
            harness2_engine::harness2_set_flags,
            harness2_engine::harness2_install,
            harness2_engine::harness2_check,
            harness2_engine::harness2_demo,
            harness2_engine::harness2_score,
            harness2_engine::harness2_library,
            harness2_engine::harness2_keep,
            harness2_engine::harness2_promote,
            harness2_engine::harness2_revert,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(mut h) = app.state::<AppState>().app_handle.lock() {
                *h = Some(handle.clone());
            }
            crate::workspace_bridge::start(handle.clone());
            crate::mcp_acp_automesh::start(handle.clone());
            crate::tunnel::ensure_installed(handle.clone());
            crate::harness2_engine::ensure_installed(handle.clone());
            // Auto-connect desktop MCP clients (Claude Code, Cursor, VS Code,
            // Claude Desktop, ...) at launch. This is the default "connect
            // apps on this computer" behavior; the Mesh studio button re-runs
            // the same idempotent write.
            {
                let auto_handle = handle.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        if crate::workspace_bridge::status().port != 0 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    let Some(state) = auto_handle.try_state::<AppState>() else { return };
                    let Ok(conn) = state.conn.lock() else { return };
                    match crate::mcp_acp_automesh::connect_all(&auto_handle, &conn, &state.home) {
                        Ok(notes) => {
                            let count = notes.len();
                            ipc_push(&state.ipc, &format!("Auto-connected desktop MCP clients ({count} notes)."));
                        }
                        Err(error) => ipc_push(&state.ipc, &format!("Desktop MCP auto-connect did not finish: {error}")),
                    }
                });
            }
            ensure_dev_server(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Ronic OS window failed to start");
}

/// The dev watcher restarts the exe while the previous instance can still
/// hold the WebView2 profile, which fails startup with "resource is in use"
/// (0x800700AA). A fresh instance clears any other running copy first — the
/// same single-instance policy the launcher script applies.
fn clear_stale_instances() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let self_pid = std::process::id();
        let output = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq omniworkspace.exe", "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(output) = output else { return };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let parts: Vec<&str> = line.split(',').map(str::trim).collect();
            if parts.len() < 2 || !parts[0].trim_matches('"').eq_ignore_ascii_case("omniworkspace.exe") {
                continue;
            }
            let Ok(pid) = parts[1].trim_matches('"').parse::<u32>() else { continue };
            if pid == self_pid {
                continue;
            }
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        // WebView2 runs out of process: the profile lock lives with
        // msedgewebview2.exe children that survive the parent. A restart also
        // leaves the previous instance's tunnel behind. Clear both, or the
        // new window still hits "resource is in use" and tunnels pile up.
        let sweep = "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe' OR Name = 'cloudflared.exe'\" | Where-Object { $_.CommandLine -like '*omniworkspace*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        let _ = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", sweep])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        std::thread::sleep(Duration::from_millis(800));
    }
    #[cfg(not(windows))]
    {}
}

fn find_project_root() -> Option<PathBuf> {
    if let Ok(dir) = std::env::current_dir() {
        if dir.join("package.json").exists() {
            return Some(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..5 {
            if let Some(p) = cur {
                if p.join("package.json").exists() {
                    return Some(p.to_path_buf());
                }
                cur = p.parent();
            } else {
                break;
            }
        }
    }
    None
}

fn find_node_executable() -> PathBuf {
    if let Some(found) = crate::util::which("node") {
        return PathBuf::from(found);
    }
    let mut candidates = vec![
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("hermes").join("node").join("node.exe"));
    }
    for p in candidates {
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("node")
}

fn ensure_dev_server(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        // If 1420 is already listening, nothing to do
        if std::net::TcpStream::connect("127.0.0.1:1420").is_ok() {
            return;
        }

        // 1420 is not listening yet. Show user-friendly connecting screen so WebView2 doesn't display Edge error page.
        if let Some(window) = handle.get_webview_window("main") {
            let loading_html = r#"data:text/html,<!DOCTYPE html><html><head><meta charset='utf-8'><title>Ronic OS</title><style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0F172A;color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;user-select:none}.loader{width:40px;height:40px;border:3px solid rgba(255,255,255,0.08);border-top-color:#38BDF8;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}h2{margin:22px 0 8px 0;font-size:16px;font-weight:600;letter-spacing:-0.02em}p{margin:0;font-size:12px;color:#94A3B8}#btn{margin-top:22px;padding:6px 16px;background:#1E293B;color:#E2E8F0;border:1px solid #334155;border-radius:6px;font-size:12px;cursor:pointer;transition:all .15s}#btn:hover{background:#334155}</style></head><body><div class='loader'></div><h2>Connecting to Ronic OS...</h2><p id='msg'>Starting workspace dev server on port 1420</p><button id='btn' onclick='window.location.href="http://127.0.0.1:1420/"'>Reload</button><script>let count=0;function check(){fetch('http://127.0.0.1:1420/',{mode:'no-cors',cache:'no-store'}).then(()=>{document.getElementById('msg').innerText='Connected! Loading workspace...';window.location.href='http://127.0.0.1:1420/'}).catch(()=>{count++;if(count>10){document.getElementById('msg').innerText='Waiting for Vite dev server (127.0.0.1:1420)...'}setTimeout(check,350)})}setTimeout(check,200)</script></body></html>"#;
            if let Ok(parsed) = url::Url::parse(loading_html) {
                let _ = window.navigate(parsed);
            }
        }

        // Try to start Vite dev server
        if let Some(root) = find_project_root() {
            let vite_bin = root.join("node_modules").join("vite").join("bin").join("vite.js");
            if vite_bin.exists() {
                let node_exe = find_node_executable();
                let mut cmd = std::process::Command::new(node_exe);
                cmd.arg(&vite_bin).current_dir(&root);
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }
                let _ = cmd.spawn();
            }
        }

        // Poll up to 60 times (approx 15 seconds)
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if std::net::TcpStream::connect("127.0.0.1:1420").is_ok() {
                std::thread::sleep(std::time::Duration::from_millis(150));
                if let Some(window) = handle.get_webview_window("main") {
                    if let Ok(target) = url::Url::parse("http://127.0.0.1:1420/") {
                        let _ = window.navigate(target);
                    } else {
                        let _ = window.eval("window.location.href = 'http://127.0.0.1:1420/'");
                    }
                }
                return;
            }
        }

        // If Vite still didn't respond after 15s, check if dist/index.html exists as fallback
        if let Some(root) = find_project_root() {
            let dist_index = root.join("dist").join("index.html");
            if dist_index.exists() {
                if let Ok(dist_url) = url::Url::from_file_path(&dist_index) {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate(dist_url);
                    }
                }
            }
        }
    });
}

fn spawn_watchdog(db_path: PathBuf, beat: Arc<AtomicU64>) {
    std::thread::spawn(move || {
        let Ok(conn) = Connection::open(&db_path) else { return };
        let _ = conn.pragma_update(None, "busy_timeout", "5000");
        let mut tick = 0u32;
        loop {
            beat.store(now_ms() as u64, Ordering::Relaxed);
            let _ = db::kv_set(&conn, "heartbeat_ms", &now_ms().to_string());
            if tick % 40 == 0 {
                if let Some(price) = fetch_btc() {
                    let _ = db::kv_set(&conn, "quote_btc", &price);
                }
            }
            tick = tick.wrapping_add(1);
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg(test)]
mod kernel_flow {
    use crate::snapshot::Meta;
    use crate::util::now_ms;

    #[test]
    fn seed_loads_and_the_policy_gate_moves_only_approved_funds() {
        let home = std::env::temp_dir().join(format!("omni-kernel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        crate::db::migrate(&conn).unwrap();
        crate::db::drop_reference_fixture(&conn, &home).unwrap();
        crate::db::seed_if_empty(&conn, &home).unwrap();
        let snap = crate::snapshot::load(
            &conn,
            &Meta { home: home.display().to_string(), heartbeat_ms: now_ms() as u64, proxy_port: 4141, ipc: vec![], unlocked: true },
        )
        .unwrap();
        assert!(snap.sandbox);
        assert_eq!(snap.kernel, "rust");
        assert!(snap.profiles.is_empty());
        assert!(snap.workflows.is_empty());
        assert!(snap.threads.is_empty());
        assert!(!snap.onboarding_complete);
        let before: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail='crypto_x402'", [], |r| r.get(0)).unwrap();
        assert!(before.abs() < 0.0001);
        let credit = crate::wallet::settle(&conn, "", "crypto_x402", 1.0, "$1.00", "self", "top-up", "user", "x402", None, "credit").unwrap();
        assert!(credit.contains("auto_signed_by_rust"), "{credit}");
        let tiny = crate::wallet::settle(&conn, "", "crypto_x402", 0.02, "$0.02", "test", "tiny", "agent", "x402", Some(10), "spend").unwrap();
        assert!(tiny.contains("auto_signed_by_rust"), "{tiny}");
        let after: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail='crypto_x402'", [], |r| r.get(0)).unwrap();
        assert!((after - 0.98).abs() < 0.0001);
        let held = crate::wallet::settle(&conn, "", "crypto_x402", 12.0, "$12", "test", "big", "agent", "x402", Some(10), "spend").unwrap();
        assert!(held.contains("pending_approval"), "{held}");
        let still: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail='crypto_x402'", [], |r| r.get(0)).unwrap();
        assert!((still - after).abs() < 0.0001);
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, daily_wallet_limit_usd, created_at) VALUES ('bot_cap','@cap','Cap','NW','soul','prov_ollama','prov_gemini','prov_openrouter',0.05,1)",
            [],
        )
        .unwrap();
        let under = crate::wallet::settle(&conn, "bot_cap", "crypto_x402", 0.04, "$0.04", "test", "under bot cap", "agent", "x402", Some(10), "spend").unwrap();
        assert!(under.contains("auto_signed_by_rust"), "{under}");
        let over = crate::wallet::settle(&conn, "bot_cap", "crypto_x402", 0.02, "$0.02", "test", "over bot cap", "agent", "x402", Some(10), "spend").unwrap();
        assert!(over.contains("rejected_by_policy"), "{over}");
        conn.execute("DELETE FROM bot_profiles WHERE id = 'bot_cap'", []).unwrap();
        let note = crate::repair::doctor(&conn, &home).unwrap();
        assert!(!home.join("extensions").join("skills").join("scraper.js").exists(), "{note}");
        crate::db::seed_if_empty(&conn, &home).unwrap();
        let bots: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles", [], |r| r.get(0)).unwrap();
        assert_eq!(bots, 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn turn_id_survives_migrate_and_snapshot() {
        let home = std::env::temp_dir().join(format!("omni-turn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE execution_steps (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                role TEXT NOT NULL,
                model_used TEXT NOT NULL DEFAULT '',
                content_markdown TEXT NOT NULL DEFAULT '',
                action_type TEXT NOT NULL,
                action_payload_json TEXT NOT NULL DEFAULT '{}',
                execution_latency_ms INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            INSERT INTO execution_steps (id, thread_id, role, model_used, content_markdown, action_type, action_payload_json, execution_latency_ms, created_at)
            VALUES ('step_old', 'thread_turn', 'user', '', 'before the column', 'message', '{}', 0, 1);",
        )
        .unwrap();
        crate::db::migrate(&conn).unwrap();
        let stored: String = conn.query_row("SELECT turn_id FROM execution_steps WHERE id = 'step_old'", [], |row| row.get(0)).unwrap();
        assert_eq!(stored, "");
        crate::db::seed_if_empty(&conn, &home).unwrap();
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, created_at) VALUES ('bot_turn','@turn','Turn','NW','soul','prov_ollama','prov_gemini','prov_openrouter',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_threads (id, bot_profile_id, title, status, compacted_context_capsule, is_pinned, updated_at) VALUES ('thread_turn','bot_turn','Turn','idle','',0,1)",
            [],
        )
        .unwrap();
        crate::db::kv_set(&conn, "active_thread", "thread_turn").unwrap();
        let meta = crate::snapshot::Meta { home: home.display().to_string(), heartbeat_ms: now_ms() as u64, proxy_port: 4141, ipc: vec![], unlocked: true };
        let before = crate::snapshot::load(&conn, &meta).unwrap();
        let old = before.steps.iter().find(|step| step.id == "step_old").unwrap();
        assert_eq!(old.turn_id, "");
        crate::db::insert_step_in(&conn, "thread_turn", "turn_live", "assistant", "Grok", "after", "message", &serde_json::json!({}), 1).unwrap();
        let after = crate::snapshot::load(&conn, &meta).unwrap();
        let live = after.steps.iter().find(|step| step.turn_id == "turn_live").unwrap();
        assert_eq!(live.content_markdown, "after");
        assert_eq!(after.steps.iter().filter(|step| step.thread_id == "thread_turn").count(), 2);
        let _ = std::fs::remove_dir_all(&home);
    }
}

fn fetch_btc() -> Option<String> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(4)).build().ok()?;
    let value: serde_json::Value = client.get("https://api.coinbase.com/v2/prices/BTC-USD/spot").send().ok()?.json().ok()?;
    let amount = value.get("data")?.get("amount")?.as_str()?;
    let number: f64 = amount.parse().ok()?;
    Some(format!("${number:.0}"))
}
