//! Public HTTPS tunnel for the local MCP bridge.
//!
//! Web harnesses (ChatGPT apps, Claude connectors) fetch an MCP server from
//! OpenAI's or Anthropic's own cloud, so a `127.0.0.1` URL can never work for
//! them. This module fronts the token-gated alias server (port 8765) with a
//! Cloudflare quick tunnel and hands the user one URL that already contains
//! the bridge token as a query parameter. Without that token the alias server
//! answers 401, so the public URL alone grants nothing. The timestamp of the
//! last authorized MCP call is kept as real evidence that a harness reached
//! the bridge — the presence of a webview profile folder proves nothing.

use crate::util::{now_ms, product_home};
use regex::Regex;
use serde::Serialize;
use tauri::Manager;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const DOWNLOAD_URL: &str = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const ALIAS_PORT: u16 = 8765;
const START_TIMEOUT_MS: u64 = 45_000;

static LAST_MCP_CALL_MS: AtomicI64 = AtomicI64::new(0);
static TUNNEL_LOG: Mutex<String> = Mutex::new(String::new());
static PREINSTALLING: AtomicBool = AtomicBool::new(false);

struct TunnelState {
    child: Option<Child>,
    url: String,
    since_ms: i64,
    note: String,
}

static TUNNEL: Mutex<TunnelState> = Mutex::new(TunnelState {
    child: None,
    url: String::new(),
    since_ms: 0,
    note: String::new(),
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub binary_present: bool,
    pub downloading: bool,
    pub running: bool,
    pub public_url: String,
    pub public_mcp_url: String,
    pub since_ms: i64,
    pub last_mcp_call_ms: i64,
    pub note: String,
}

/// Called by the alias server whenever an authorized MCP request arrives. A
/// fresh timestamp after the tunnel is up is the only real proof that a web
/// harness connected.
pub fn record_mcp_call() {
    LAST_MCP_CALL_MS.store(now_ms(), Ordering::Relaxed);
}

pub fn binary_path() -> Option<PathBuf> {
    let local = product_home().join("bin").join(cloudflared_name());
    if local.is_file() {
        return Some(local);
    }
    crate::util::which("cloudflared").map(PathBuf::from)
}

fn cloudflared_name() -> &'static str {
    if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" }
}

pub fn status(token: &str) -> TunnelStatus {
    let state = TUNNEL.lock().unwrap_or_else(|poison| poison.into_inner());
    let running = state.child.is_some() && !state.url.is_empty();
    let public_mcp_url = if running && !token.is_empty() {
        format!("{}?token={}", join_mcp(&state.url), token)
    } else {
        String::new()
    };
    TunnelStatus {
        binary_present: binary_path().is_some(),
        downloading: PREINSTALLING.load(Ordering::Relaxed),
        running,
        public_url: state.url.clone(),
        public_mcp_url,
        since_ms: state.since_ms,
        last_mcp_call_ms: LAST_MCP_CALL_MS.load(Ordering::Relaxed),
        note: state.note.clone(),
    }
}

/// Keep the tunnel available and running: download cloudflared once, then
/// start the tunnel as soon as the local MCP alias is listening, so web
/// harnesses have a live public URL without anyone opening the Mesh studio.
/// The Start/Stop buttons there still override this.
pub fn ensure_installed(app: tauri::AppHandle) {
    let have_binary = binary_path().is_some();
    if !have_binary && PREINSTALLING.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(move || {
        let note = |line: String| {
            if let Some(state) = app.try_state::<crate::AppState>() {
                crate::util::ipc_push(&state.ipc, &line);
            }
        };
        if !have_binary {
            let outcome = download_blocking();
            PREINSTALLING.store(false, Ordering::Relaxed);
            match &outcome {
                Ok(done) => note(format!("cloudflared is installed. {done}")),
                Err(error) => {
                    note(format!("cloudflared did not install automatically: {error}. The Mesh studio's Download button retries."));
                    return;
                }
            }
        }
        for _ in 0..40 {
            if TcpStream::connect(("127.0.0.1", ALIAS_PORT)).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        match start() {
            Ok(message) => note(format!("Public MCP tunnel is live. {message}")),
            Err(error) => note(format!("The public tunnel did not start automatically: {error}. Use Start public tunnel in the Mesh studio.")),
        }
    });
}

fn join_mcp(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.ends_with("/mcp") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/mcp")
    }
}

pub fn start() -> Result<String, String> {
    let binary = binary_path().ok_or_else(|| {
        "cloudflared is not installed. Use Download cloudflared, or install it yourself and try again.".to_string()
    })?;
    if TcpStream::connect(("127.0.0.1", ALIAS_PORT)).is_err() {
        return Err(format!("The local MCP alias on port {ALIAS_PORT} is not up yet. Wait a moment and try again."));
    }
    {
        let mut state = TUNNEL.lock().unwrap_or_else(|poison| poison.into_inner());
        if state.child.is_some() && !state.url.is_empty() {
            return Ok(format!("The tunnel is already running at {}.", state.url));
        }
        state.url = String::new();
        state.note = "Starting the tunnel.".into();
    }
    let mut command = Command::new(&binary);
    command
        .arg("tunnel")
        .arg("--url").arg(format!("http://127.0.0.1:{ALIAS_PORT}"))
        .arg("--no-autoupdate")
        .arg("--protocol").arg("http2")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| format!("cloudflared did not start: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        spawn_log_reader(stdout);
    }
    if let Some(stderr) = stderr {
        spawn_log_reader(stderr);
    }
    let pattern = tunnel_url_pattern();
    let deadline = std::time::Instant::now() + Duration::from_millis(START_TIMEOUT_MS);
    let url = loop {
        if child.try_wait().is_ok() {
            let log_snapshot = TUNNEL_LOG.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
            TUNNEL.lock().unwrap_or_else(|poison| poison.into_inner()).note = "cloudflared exited.".into();
            return Err(format!("cloudflared exited before the tunnel was ready. Last output: {}", tail(&log_snapshot, 600)));
        }
        let found = {
            let sink = TUNNEL_LOG.lock().unwrap_or_else(|poison| poison.into_inner());
            pattern.find(&sink).map(|hit| hit.as_str().to_string())
        };
        if let Some(url) = found {
            break url;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let log_snapshot = TUNNEL_LOG.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
            TUNNEL.lock().unwrap_or_else(|poison| poison.into_inner()).note = "Tunnel start timed out.".into();
            return Err(format!("cloudflared did not report a URL in time. Last output: {}", tail(&log_snapshot, 600)));
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    let note = {
        let mut state = TUNNEL.lock().unwrap_or_else(|poison| poison.into_inner());
        state.child = Some(child);
        state.url = url.clone();
        state.since_ms = now_ms();
        state.note = format!("Tunnel is live at {url}. Register the full MCP URL (with token) in the harness connector settings.");
        state.note.clone()
    };
    Ok(note)
}

pub fn stop() -> Result<String, String> {
    let mut state = TUNNEL.lock().unwrap_or_else(|poison| poison.into_inner());
    match state.child.as_mut() {
        Some(child) => {
            let pid = child.id();
            kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            state.child = None;
            state.url = String::new();
            state.since_ms = 0;
            state.note = "Tunnel stopped.".into();
            Ok("Tunnel stopped.".into())
        }
        None => {
            state.url = String::new();
            state.note = String::new();
            Ok("No tunnel was running.".into())
        }
    }
}

fn tunnel_url_pattern() -> Regex {
    Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com").expect("tunnel url pattern")
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(stream: R) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let mut sink = TUNNEL_LOG.lock().unwrap_or_else(|poison| poison.into_inner());
            sink.push_str(&line);
            sink.push('\n');
                if sink.len() > 32_768 {
                    let keep_from = sink.len() - 32_768;
                    sink.drain(..keep_from);
                }
        }
    });
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console window next to the desktop app.
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// cloudflared spawns helper processes; take the whole tree down.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

/// Download the single-file cloudflared binary into the product home. Runs on
/// a blocking thread; reqwest::blocking panics inside the async runtime.
pub fn download_blocking() -> Result<String, String> {
    let dir = product_home().join("bin");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let final_path = dir.join(cloudflared_name());
    let part_path = dir.join(format!("{}.part", cloudflared_name()));
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?
        .get(DOWNLOAD_URL)
        .send()
        .map_err(|error| format!("The download did not start: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("The download server answered {}.", response.status()));
    }
    let bytes = response.bytes().map_err(|error| format!("The download did not finish: {error}"))?;
    if bytes.len() < 5_000_000 {
        return Err("The download was smaller than cloudflared should be, so it was discarded.".into());
    }
    if cfg!(windows) && !bytes.starts_with(b"MZ") {
        return Err("The download was not a Windows executable, so it was discarded.".into());
    }
    std::fs::write(&part_path, &bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&part_path, &final_path).map_err(|error| error.to_string())?;
    Ok(format!("cloudflared is ready at {}.", final_path.display()))
}

fn tail(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.trim().to_string();
    }
    let clipped: String = text.chars().skip(count - max_chars).collect();
    clipped.trim().to_string()
}

fn bridge_token(home: &std::path::Path) -> String {
    std::fs::read_to_string(home.join("bridge-token")).unwrap_or_default().trim().to_string()
}

#[tauri::command]
pub async fn mesh_tunnel_status(state: tauri::State<'_, crate::AppState>) -> Result<TunnelStatus, String> {
    Ok(status(&bridge_token(&state.home)))
}

#[tauri::command]
pub async fn mesh_tunnel_start() -> Result<TunnelStatus, String> {
    let note = tauri::async_runtime::spawn_blocking(start).await.map_err(|error| error.to_string())??;
    let mut view = status(&bridge_token(&crate::util::product_home()));
    if view.running {
        view.note = note;
    }
    Ok(view)
}

#[tauri::command]
pub async fn mesh_tunnel_stop() -> Result<TunnelStatus, String> {
    tauri::async_runtime::spawn_blocking(stop).await.map_err(|error| error.to_string())??;
    Ok(status(&bridge_token(&crate::util::product_home())))
}

#[tauri::command]
pub async fn mesh_tunnel_download() -> Result<TunnelStatus, String> {
    tauri::async_runtime::spawn_blocking(download_blocking).await.map_err(|error| error.to_string())??;
    let mut view = status(&bridge_token(&crate::util::product_home()));
    view.note = "cloudflared downloaded. Start the tunnel when you want web harnesses on MCP.".into();
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_url_pattern_reads_quick_tunnel_output() {
        let pattern = tunnel_url_pattern();
        let log = "2026-10-25T00:00:00Z INF |  https://example-random-words.trycloudflare.com  |\nnoise";
        assert_eq!(pattern.find(log).unwrap().as_str(), "https://example-random-words.trycloudflare.com");
        assert!(pattern.find("no url here").is_none());
    }

    #[test]
    fn mcp_url_joins_the_token_as_query() {
        assert_eq!(join_mcp("https://x.trycloudflare.com"), "https://x.trycloudflare.com/mcp");
        assert_eq!(join_mcp("https://x.trycloudflare.com/"), "https://x.trycloudflare.com/mcp");
    }

    #[test]
    fn idle_tunnel_reports_no_evidence() {
        let view = status("token");
        assert!(!view.running);
        assert_eq!(view.public_mcp_url, "");
        assert_eq!(view.public_mcp_url, "");
    }
}
