use crate::db;
use crate::error::Result;
use crate::models::{ScanHit, ScanReport};
use crate::util::{exists_file, now_ms, user_home, which, windows_bin_candidates, wsl_which};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

struct Want {
    name: &'static str,
    category: &'static str,
    commands: &'static [&'static str],
    extras: Vec<PathBuf>,
}

pub fn discover() -> (Vec<ScanHit>, Vec<String>, Instant) {
    let started = Instant::now();
    let mut found = Vec::new();
    let mut missing = Vec::new();
    let home = user_home();
    let product = crate::util::product_home();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);

    let mut wants = vec![
        Want { name: "Claude Code", category: "cli", commands: &["claude"], extras: windows_bin_candidates("claude") },
        Want { name: "Codex CLI", category: "cli", commands: &["codex"], extras: windows_bin_candidates("codex") },
        Want { name: "Gemini CLI", category: "cli", commands: &["agy", "gemini"], extras: {
            let mut extras = windows_bin_candidates("agy");
            extras.extend(windows_bin_candidates("gemini"));
            if let Some(local) = local.as_ref() {
                extras.push(local.join("agy").join("bin").join("agy.exe"));
            }
            extras
        } },
        Want { name: "Aider", category: "cli", commands: &["aider"], extras: windows_bin_candidates("aider") },
        Want { name: "OpenCode", category: "cli", commands: &["opencode"], extras: windows_bin_candidates("opencode") },
        Want { name: "Ollama", category: "cli", commands: &["ollama"], extras: {
            let mut extras = windows_bin_candidates("ollama");
            if let Some(local) = local.as_ref() {
                extras.push(local.join("Programs").join("Ollama").join("ollama.exe"));
            }
            extras
        } },
        Want { name: "uv", category: "cli", commands: &["uv"], extras: windows_bin_candidates("uv") },
        Want { name: "bun", category: "cli", commands: &["bun"], extras: windows_bin_candidates("bun") },
        Want { name: "node", category: "cli", commands: &["node"], extras: Vec::new() },
        Want { name: "git", category: "cli", commands: &["git"], extras: Vec::new() },
        Want { name: "python", category: "cli", commands: &["python"], extras: Vec::new() },
    ];

    let mut cursor = Vec::new();
    let mut code = Vec::new();
    let mut obsidian = Vec::new();
    if let Some(local) = local.as_ref() {
        cursor.push(local.join("Programs").join("cursor").join("Cursor.exe"));
        cursor.push(local.join("cursor").join("Cursor.exe"));
        code.push(local.join("Programs").join("Microsoft VS Code").join("Code.exe"));
        code.push(local.join("Programs").join("Microsoft VS Code Insiders").join("Code - Insiders.exe"));
        obsidian.push(local.join("Programs").join("Obsidian").join("Obsidian.exe"));
        obsidian.push(local.join("Obsidian").join("Obsidian.exe"));
    }
    if let Some(program_files) = program_files.as_ref() {
        cursor.push(program_files.join("Cursor").join("Cursor.exe"));
        code.push(program_files.join("Microsoft VS Code").join("Code.exe"));
        code.push(program_files.join("Microsoft VS Code Insiders").join("Code - Insiders.exe"));
        obsidian.push(program_files.join("Obsidian").join("Obsidian.exe"));
    }
    wants.push(Want { name: "Cursor", category: "ide", commands: &["cursor"], extras: cursor });
    wants.push(Want { name: "VS Code", category: "ide", commands: &["code", "code-insiders"], extras: code });
    wants.push(Want { name: "Obsidian", category: "ide", commands: &[], extras: obsidian });

    let mut wsl_needed: Vec<usize> = Vec::new();
    let mut native: Vec<Option<String>> = Vec::with_capacity(wants.len());
    for (index, want) in wants.iter().enumerate() {
        let path = native_hit(want);
        if path.is_none() && want.category == "cli" && !want.commands.is_empty() {
            wsl_needed.push(index);
        }
        native.push(path);
    }

    let mut wsl_hits: HashMap<String, String> = HashMap::new();
    if !wsl_needed.is_empty() {
        let names: Vec<&str> = wsl_needed.iter().flat_map(|index| wants[*index].commands.iter().copied()).collect();
        for (name, path) in wsl_which(&names) {
            wsl_hits.insert(name, path);
        }
    }

    for (index, want) in wants.iter().enumerate() {
        if let Some(path) = native[index].clone() {
            found.push(ScanHit { name: want.name.into(), path, category: want.category.into() });
            continue;
        }
        if let Some(unix) = want.commands.iter().find_map(|cmd| wsl_hits.get(*cmd)) {
            found.push(ScanHit {
                name: want.name.into(),
                path: format!("wsl:{unix}"),
                category: want.category.into(),
            });
        } else {
            missing.push(want.name.into());
        }
    }

    for (id, name) in [("grokbot", "Grokbot"), ("muse", "Muse"), ("hermes", "Hermes")] {
        let editions = crate::workspace_apps::detected_editions(id, false);
        let installed = editions.desktop.or(editions.terminal).or_else(|| bot_dir(&product, &home, id));
        if let Some(path) = installed {
            found.push(ScanHit { name: name.into(), path: path.display().to_string(), category: "bot".into() });
        } else {
            missing.push(name.into());
        }
    }
    for (name, rels) in [("Dots", &["bots/dots"][..]), ("OpenClaw", &["bots/openclaw"][..])] {
        let path = rels.iter().map(|rel| product.join(rel)).chain(rels.iter().map(|rel| home.join(rel))).find(|path| path.is_dir());
        if let Some(path) = path {
            found.push(ScanHit { name: name.into(), path: path.display().to_string(), category: "bot".into() });
        } else {
            missing.push(name.into());
        }
    }

    (found, missing, started)
}

pub fn commit(conn: &Connection, found: Vec<ScanHit>, missing: Vec<String>, started: Instant) -> Result<ScanReport> {
    apply_found(conn, &found)?;
    mark_absent(conn, &missing)?;
    mark_web_ready(conn)?;

    let mut settings = db::settings_of(conn)?;
    assign(&mut settings.claude_path, &found, "Claude Code");
    assign(&mut settings.codex_path, &found, "Codex CLI");
    assign(&mut settings.gemini_path, &found, "Gemini CLI");
    assign(&mut settings.aider_path, &found, "Aider");
    assign(&mut settings.opencode_path, &found, "OpenCode");
    assign(&mut settings.uv_path, &found, "uv");
    assign(&mut settings.bun_path, &found, "bun");
    if settings.obsidian_vault.is_empty() {
        let guess = user_home().join("Documents").join("MainVault");
        if guess.is_dir() {
            settings.obsidian_vault = guess.display().to_string();
        }
    }
    db::save_settings(conn, &settings)?;

    let report = ScanReport {
        duration_ms: started.elapsed().as_millis() as i64,
        found,
        missing,
    };
    db::kv_set(conn, "last_scan", &serde_json::to_string(&report)?)?;
    db::kv_set(conn, "last_scan_ms", &now_ms().to_string())?;
    Ok(report)
}

pub fn note_installed_apps(conn: &Connection) -> Result<()> {
    let mut found = Vec::new();
    for (id, name, category) in [
        ("cursor", "Cursor", "ide"),
        ("vscode", "VS Code", "ide"),
        ("claude-code", "Claude Code", "cli"),
        ("ollama", "Ollama", "cli"),
        ("obsidian", "Obsidian", "ide"),
        ("hermes", "Hermes", "bot"),
        ("grokbot", "Grokbot", "bot"),
        ("muse", "Muse", "bot"),
    ] {
        let editions = crate::workspace_apps::detected_editions(id, false);
        let Some(path) = editions.desktop.as_ref().or(editions.terminal.as_ref()) else { continue };
        found.push(ScanHit { name: name.into(), path: path.display().to_string(), category: category.into() });
    }
    apply_found(conn, &found)?;
    Ok(())
}

fn bot_dir(product: &Path, home: &Path, id: &str) -> Option<PathBuf> {
    let rel = format!("bots/{id}");
    let product_path = product.join(&rel);
    if product_path.is_dir() {
        return Some(product_path);
    }
    let home_path = home.join(rel);
    if home_path.is_dir() {
        Some(home_path)
    } else {
        None
    }
}

fn native_hit(want: &Want) -> Option<String> {
    if let Some(path) = want.extras.iter().find(|path| path.is_file()) {
        return Some(path.display().to_string());
    }
    for cmd in want.commands {
        if let Some(path) = which(cmd) {
            return Some(path);
        }
        if cfg!(windows) {
            if let Some(path) = which(&format!("{cmd}.cmd")) {
                return Some(path);
            }
            if let Some(path) = which(&format!("{cmd}.exe")) {
                return Some(path);
            }
        }
    }
    None
}

fn assign(slot: &mut String, found: &[ScanHit], name: &str) {
    if !slot.is_empty() && (exists_file(slot) || slot.starts_with("wsl:")) {
        return;
    }
    if let Some(hit) = found.iter().find(|hit| hit.name == name) {
        *slot = hit.path.clone();
    }
}

fn detection_detail(path: &str) -> String {
    if path.starts_with("wsl:") {
        format!("Available via WSL2 ({path})")
    } else {
        format!("Detected on System ({path})")
    }
}

fn apply_found(conn: &Connection, found: &[ScanHit]) -> Result<()> {
    let map = [
        ("Claude Code", "app_claude", "prov_claude"),
        ("Codex CLI", "app_codex", ""),
        ("Gemini CLI", "app_gemini", "prov_gemini"),
        ("Aider", "app_aider", ""),
        ("OpenCode", "app_opencode", ""),
        ("Cursor", "app_cursor", ""),
        ("VS Code", "app_vscode", ""),
        ("Obsidian", "app_obsidian", ""),
        ("Grokbot", "app_grokbot", ""),
        ("Muse", "app_muse", ""),
        ("Dots", "app_dots", ""),
        ("Hermes", "app_hermes", ""),
        ("OpenClaw", "app_openclaw", ""),
        ("Ollama", "", "prov_ollama"),
    ];
    for hit in found {
        for (name, app, provider) in map {
            if hit.name != name {
                continue;
            }
            let detail = detection_detail(&hit.path);
            if !app.is_empty() {
                conn.execute(
                    "UPDATE linked_local_apps SET executable_path = ?1, status = 'ready', detail = ?2, updated_at = ?3 WHERE id = ?4 AND (executable_path = '' OR status = 'missing')",
                    params![hit.path, detail, now_ms(), app],
                )?;
            }
            if provider.is_empty() {
                continue;
            }
            let kind: String = conn
                .query_row("SELECT provider_type FROM provider_accounts WHERE id = ?1", params![provider], |row| row.get(0))
                .unwrap_or_default();
            if provider == "prov_ollama" {
                conn.execute(
                    "UPDATE provider_accounts SET health_detail = ?1 WHERE id = ?2 AND health_detail NOT LIKE 'Connected%'",
                    params![format!("Detected on System ({})", hit.path), provider],
                )?;
                continue;
            }
            // Never overwrite a web session URL with a CLI path. Codex used to land on the ChatGPT row.
            if kind != "cli_subprocess" {
                continue;
            }
            let current: String = conn
                .query_row("SELECT binary_or_endpoint FROM provider_accounts WHERE id = ?1", params![provider], |row| row.get(0))
                .unwrap_or_default();
            let stale = current.is_empty() || (!current.starts_with("wsl:") && !Path::new(&current).exists());
            if stale {
                conn.execute(
                    "UPDATE provider_accounts SET binary_or_endpoint = ?1, health_detail = ?2 WHERE id = ?3",
                    params![hit.path, detail, provider],
                )?;
            } else {
                conn.execute(
                    "UPDATE provider_accounts SET health_detail = ?1 WHERE id = ?2",
                    params![detection_detail(&current), provider],
                )?;
            }
        }
    }
    Ok(())
}

fn mark_absent(conn: &Connection, missing: &[String]) -> Result<()> {
    let map = [
        ("Claude Code", "prov_claude"),
        ("Gemini CLI", "prov_gemini"),
    ];
    for (name, provider) in map {
        if !missing.iter().any(|item| item == name) {
            continue;
        }
        conn.execute(
            "UPDATE provider_accounts SET health_detail = 'Not installed' WHERE id = ?1 AND binary_or_endpoint = '' AND health_detail NOT LIKE 'Connected%'",
            params![provider],
        )?;
    }
    Ok(())
}

fn mark_web_ready(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE provider_accounts SET binary_or_endpoint = 'https://grok.com' WHERE binary_or_endpoint LIKE '%grok.x.ai%'",
        [],
    )?;
    conn.execute(
        "UPDATE provider_accounts SET health_detail = 'Not signed in. Open the site, or paste an API key to chat here.' WHERE provider_type IN ('isolated_webview', 'official_oauth') AND (health_detail = '' OR health_detail LIKE 'Connected%' OR health_detail LIKE 'Web Session%')",
        [],
    )?;
    Ok(())
}

pub fn link_ready(conn: &Connection) -> Result<i64> {
    let n = conn.execute("UPDATE linked_local_apps SET status = 'linked' WHERE status = 'ready'", [])?;
    Ok(n as i64)
}
