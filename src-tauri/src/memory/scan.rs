use crate::db;
use crate::error::Result;
use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct EngineProbe {
    pub port_8000: bool,
    pub banner_8000: String,
    pub letta: bool,
    pub khoj: bool,
    pub vaults: Vec<String>,
}

pub fn scan_engines(conn: &Connection) -> Result<String> {
    let started = Instant::now();
    let mut settings = db::settings_of(conn)?;
    let mut vaults = obsidian_vaults();
    if Path::new(&settings.obsidian_vault).is_dir() {
        if !vaults.iter().any(|path| path == &settings.obsidian_vault) {
            vaults.insert(0, settings.obsidian_vault.clone());
        }
    } else if settings.obsidian_vault.is_empty() {
        if let Some(found) = vaults.first() {
            settings.obsidian_vault = found.clone();
            db::save_settings(conn, &settings)?;
        }
    }
    let ports = probe_ports();
    let probe = EngineProbe { vaults, ..ports };
    apply_scan(conn, &probe, started.elapsed().as_millis() as i64)?;
    Ok(summary(&probe))
}

pub fn apply_scan(conn: &Connection, probe: &EngineProbe, latency_ms: i64) -> Result<()> {
    let now = now_ms();
    let banner = probe.banner_8000.to_ascii_lowercase();
    let named_cognee = probe.port_8000 && banner.contains("cognee");
    let named_graphiti = probe.port_8000 && (banner.contains("graphiti") || banner.contains("zep"));
    let shared = probe.port_8000 && !named_cognee && !named_graphiti;
    let (zep_state, zep_detail) = if named_graphiti {
        ("detected", "Graphiti responded on 127.0.0.1:8000.")
    } else if shared {
        ("detected", "port 8000 is open; engine not confirmed")
    } else if probe.port_8000 {
        ("missing", "Port 8000 answered as Cognee.")
    } else {
        ("missing", "Looks for a server on 127.0.0.1:8000.")
    };
    let (cognee_state, cognee_detail) = if named_cognee {
        ("detected", "Cognee responded on 127.0.0.1:8000.")
    } else if shared {
        ("detected", "port 8000 is open; engine not confirmed")
    } else if probe.port_8000 {
        ("missing", "Port 8000 answered as Graphiti.")
    } else {
        ("missing", "Looks for Cognee on 127.0.0.1:8000.")
    };
    let vault = probe.vaults.iter().find(|path| Path::new(path).is_dir()).cloned().unwrap_or_default();
    let (obsidian_state, obsidian_endpoint, obsidian_detail) = if !vault.is_empty() && probe.khoj {
        ("detected", vault, "Vault folder found, and Khoj is listening on 42110.".to_string())
    } else if !vault.is_empty() {
        ("detected", vault.clone(), format!("Vault folder {vault}."))
    } else if probe.khoj {
        ("detected", String::new(), "Khoj is listening on 42110. No Obsidian vault path yet.".into())
    } else {
        ("missing", String::new(), "Markdown vault and wikilinks.".into())
    };
    let rows = [
        ("zep_graphiti", zep_state, "http://127.0.0.1:8000", zep_detail),
        ("cognee", cognee_state, "http://127.0.0.1:8000", cognee_detail),
        ("letta", if probe.letta { "detected" } else { "missing" }, "http://127.0.0.1:8283", if probe.letta { "Letta is listening on 8283. Attach comes in a later update." } else { "Looks for a server on 127.0.0.1:8283." }),
    ];
    for (id, availability, endpoint, detail) in rows {
        let endpoint = if availability == "missing" { "" } else { endpoint };
        conn.execute(
            "UPDATE memory_engines SET availability=?1, endpoint=?2, detail=?3, latency_ms=?4, scanned_at=?5 WHERE id=?6",
            params![availability, endpoint, detail, latency_ms, now, id],
        )?;
    }
    conn.execute(
        "UPDATE memory_engines SET availability=?1, endpoint=?2, detail=?3, latency_ms=?4, scanned_at=?5 WHERE id='obsidian_khoj'",
        params![obsidian_state, obsidian_endpoint, obsidian_detail, latency_ms, now],
    )?;
    Ok(())
}

fn summary(probe: &EngineProbe) -> String {
    let mut found = Vec::new();
    if probe.port_8000 {
        found.push("port 8000");
    }
    if probe.letta {
        found.push("Letta");
    }
    if probe.khoj {
        found.push("Khoj");
    }
    if !probe.vaults.is_empty() {
        found.push("an Obsidian vault");
    }
    if found.is_empty() {
        "Scan finished. No optional memory engine is listening. The Mem0 vault stays active.".into()
    } else {
        format!("Scan finished. Detected {}. The active engine was not changed.", found.join(", "))
    }
}

fn probe_ports() -> EngineProbe {
    let (port_8000, letta, khoj) = std::thread::scope(|scope| {
        let port_8000 = scope.spawn(|| port_open(8000));
        let letta = scope.spawn(|| port_open(8283));
        let khoj = scope.spawn(|| port_open(42110));
        (join_port(port_8000), join_port(letta), join_port(khoj))
    });
    let banner_8000 = if port_8000 { http_banner(8000) } else { String::new() };
    EngineProbe { port_8000, banner_8000, letta, khoj, vaults: Vec::new() }
}

fn join_port(handle: std::thread::ScopedJoinHandle<bool>) -> bool {
    handle.join().unwrap_or(false)
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(30)).is_ok()
}

fn http_banner(port: u16) -> String {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(40)) else { return String::new() };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(40)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(40)));
    let req = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return String::new();
    }
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).to_lowercase()
}

fn obsidian_vaults() -> Vec<String> {
    let Some(path) = obsidian_config_path() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    vaults_from_obsidian_json(&text)
}

fn obsidian_config_path() -> Option<PathBuf> {
    let windows = std::env::var_os("APPDATA").map(|root| PathBuf::from(root).join("obsidian").join("obsidian.json"));
    let mac = std::env::var_os("HOME").map(|root| PathBuf::from(root).join("Library").join("Application Support").join("obsidian").join("obsidian.json"));
    [windows, mac].into_iter().flatten().find(|path| path.is_file())
}

fn vaults_from_obsidian_json(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(vaults) = value.get("vaults").and_then(Value::as_object) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in vaults.values() {
        if let Some(path) = entry.get("path").and_then(Value::as_str) {
            if Path::new(path).is_dir() {
                out.push(path.to_string());
            }
        }
    }
    out
}
