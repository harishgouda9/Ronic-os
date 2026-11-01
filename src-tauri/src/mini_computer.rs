//! The mini computer's shell IPC: boot info, layout, app/tab control, and a
//! sandboxed file explorer (workspace + memory library) for the bot's own
//! desktop. Every command derives the bot from the CALLING webview's label,
//! so one bot's shell can never touch another bot's files.

use crate::computer_subsystem::{
    apply_chrome_visibility, broadcast_shell, chrome_label, ensure_chrome, mini_label, open_chrome_tab, reposition_chrome,
    shell_state, sync_instance_summary, sync_window_title, update_shell_state,
};
use crate::error::{err, Result};
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};

fn bot_of_webview(webview: &Webview<tauri::Wry>) -> Result<String> {
    let label = webview.label();
    let rest = label.strip_prefix("ronic_mini_comp_").ok_or_else(|| err("not a mini computer shell"))?;
    if rest.ends_with("_chrome") {
        return Err(err("not a mini computer shell"));
    }
    let id = crate::util::safe_id_component(rest)?.to_string();
    Ok(id)
}

/// Resolves which bot a command targets: an explicit `botId` (passed by the
/// chat dock's embedded panel, which runs inside the MAIN webview) wins;
/// otherwise the bot is derived from the calling mini computer shell webview.
fn resolve_bot(webview: &Webview<tauri::Wry>, bot_id: &Option<String>) -> Result<String> {
    if let Some(explicit) = bot_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(crate::util::safe_id_component(explicit)?.to_string());
    }
    bot_of_webview(webview)
}

fn bot_handle_of(app: &AppHandle, bot_id: &str) -> String {
    crate::computer_subsystem::list_bot_mini_computer_windows(app.clone())
        .into_iter()
        .find(|entry| entry.bot_id == bot_id.trim())
        .map(|entry| entry.bot_handle)
        .unwrap_or_else(|| "@bot".into())
}

// ---------------------------------------------------------------------------
// Boot / layout / app + tab control
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellBoot {
    pub bot_id: String,
    pub bot_handle: String,
    pub window_label: String,
    pub chrome_label: String,
    pub workspace_path: String,
    pub memory_path: String,
    pub session_id: String,
    pub shell: crate::computer_subsystem::ShellState,
}

#[tauri::command]
pub fn mini_shell_boot(webview: Webview<tauri::Wry>, app: AppHandle, state: tauri::State<'_, crate::AppState>, bot_id: Option<String>) -> Result<ShellBoot> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let handle = bot_handle_of(&app, &bot_id);
    let workspace = crate::bot_screen::shell_cwd(&state.home, &bot_id, "")?;
    let memory = mini_memory_dir(&state.home, &bot_id)?;
    let _ = std::fs::create_dir_all(&memory);
    // A reloaded shell (HMR, crash) must restore the correct chrome geometry
    // and visibility before the first paint.
    apply_chrome_visibility(&app, &bot_id);
    reposition_chrome(&app, &bot_id);
    sync_window_title(&app, &bot_id);
    broadcast_shell(&app, &bot_id, "booted");
    let window_label = mini_label(&bot_id)?;
    let chrome = chrome_label(&bot_id)?;
    let shell = shell_state(&bot_id);
    let session_id = format!("mini-{bot_id}");
    Ok(ShellBoot {
        session_id,
        bot_id,
        bot_handle: handle,
        window_label,
        chrome_label: chrome,
        workspace_path: workspace.to_string_lossy().to_string(),
        memory_path: memory.to_string_lossy().to_string(),
        shell,
    })
}

#[tauri::command]
pub fn mini_shell_layout(webview: Webview<tauri::Wry>, app: AppHandle, x: f64, y: f64, w: f64, h: f64, dpr: Option<f64>) -> Result<()> {
    let bot_id = bot_of_webview(&webview)?;
    if !(w.is_finite() && h.is_finite()) || w < 1.0 || h < 1.0 {
        return Ok(());
    }
    update_shell_state(&bot_id, |s| {
        s.content = [x.max(0.0), y.max(0.0), w, h];
        if let Some(dpr) = dpr {
            if dpr.is_finite() && dpr > 0.0 {
                s.dpr = dpr;
            }
        }
    });
    let visible = shell_state(&bot_id).chrome_visible;
    if visible {
        reposition_chrome(&app, &bot_id);
    }
    Ok(())
}

#[tauri::command]
pub fn mini_shell_set_app(webview: Webview<tauri::Wry>, app: AppHandle, target: String, bot_id: Option<String>) -> Result<()> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let target = match target.as_str() {
        "chrome" => "chrome",
        "files" => "files",
        "terminal" => "terminal",
        "desktop" => "desktop",
        _ => return Err(err("app must be chrome, files, terminal, or desktop")),
    };
    let has_tabs = !shell_state(&bot_id).tabs.is_empty();
    update_shell_state(&bot_id, |s| {
        s.app = target.into();
        s.chrome_visible = target == "chrome" && has_tabs;
    });
    apply_chrome_visibility(&app, &bot_id);
    sync_instance_summary(&app, &bot_id);
    broadcast_shell(&app, &bot_id, "shell");
    Ok(())
}

#[tauri::command]
pub async fn mini_open_tab(webview: Webview<tauri::Wry>, app: AppHandle, state: tauri::State<'_, crate::AppState>, bot_id: Option<String>, url: String) -> Result<()> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let home = state.home.clone();
    // Chrome webview creation must run off the main thread (wry#583).
    tauri::async_runtime::spawn_blocking(move || {
        let handle = bot_handle_of(&app, &bot_id);
        let target = crate::computer_subsystem::agent_url_allowed(&url)?;
        open_chrome_tab(&app, &home, &bot_id, &handle, target, false)?;
        Ok(())
    })
    .await
    .map_err(|e| err(format!("the tab did not open: {e}")))?
}

#[tauri::command]
pub async fn mini_close_tab(webview: Webview<tauri::Wry>, app: AppHandle, state: tauri::State<'_, crate::AppState>, bot_id: Option<String>, tab_id: String) -> Result<()> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let home = state.home.clone();
    // ensure_chrome may create the Chrome webview — off the main thread (wry#583).
    tauri::async_runtime::spawn_blocking(move || {
        let removed = update_shell_state(&bot_id, |s| {
            let before = s.tabs.len();
            s.tabs.retain(|tab| tab.id != tab_id);
            let removed = s.tabs.len() != before;
            if removed && s.active_tab == tab_id {
                s.active_tab = s.tabs.last().map(|tab| tab.id.clone()).unwrap_or_default();
            }
            removed
        });
        if !removed {
            return Err(err("no such tab"));
        }
        let shell = shell_state(&bot_id);
        match shell.tabs.iter().find(|tab| tab.id == shell.active_tab) {
            Some(active) => {
                let target = url::Url::parse(&active.url).map_err(|e| err(e.to_string()))?;
                ensure_chrome(&app, &home, &bot_id, Some(target))?;
            }
            None => {
                ensure_chrome(&app, &home, &bot_id, None)?;
                update_shell_state(&bot_id, |s| {
                    s.chrome_visible = false;
                    if s.app == "chrome" {
                        s.app = "desktop".into();
                    }
                });
                apply_chrome_visibility(&app, &bot_id);
            }
        }
        sync_instance_summary(&app, &bot_id);
        sync_window_title(&app, &bot_id);
        broadcast_shell(&app, &bot_id, "shell");
        Ok(())
    })
    .await
    .map_err(|e| err(format!("the tab did not close: {e}")))?
}

#[tauri::command]
pub async fn mini_focus_tab(webview: Webview<tauri::Wry>, app: AppHandle, state: tauri::State<'_, crate::AppState>, bot_id: Option<String>, tab_id: String) -> Result<()> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let target_url = update_shell_state(&bot_id, |s| {
        s.tabs.iter().find(|tab| tab.id == tab_id).map(|tab| tab.url.clone())
    });
    let Some(target_url) = target_url else {
        return Err(err("no such tab"));
    };
    let home = state.home.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = url::Url::parse(&target_url).map_err(|e| err(e.to_string()))?;
        update_shell_state(&bot_id, |s| {
            s.active_tab = tab_id.clone();
            s.app = "chrome".into();
            s.chrome_visible = true;
        });
        ensure_chrome(&app, &home, &bot_id, Some(target))?;
        apply_chrome_visibility(&app, &bot_id);
        sync_instance_summary(&app, &bot_id);
        sync_window_title(&app, &bot_id);
        broadcast_shell(&app, &bot_id, "chrome");
        Ok(())
    })
    .await
    .map_err(|e| err(format!("the tab did not focus: {e}")))?
}

/// Browser chrome controls from the shell toolbar: back / forward / reload /
/// address (replaces the active tab's url).
#[tauri::command]
pub async fn mini_chrome_nav(webview: Webview<tauri::Wry>, app: AppHandle, state: tauri::State<'_, crate::AppState>, kind: String, url: Option<String>, bot_id: Option<String>) -> Result<()> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let home = state.home.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let label = chrome_label(&bot_id)?;
        match kind.as_str() {
            "back" => {
                if let Some(page) = app.get_webview(&label) {
                    let _ = page.eval("history.back()");
                }
            }
            "forward" => {
                if let Some(page) = app.get_webview(&label) {
                    let _ = page.eval("history.forward()");
                }
            }
            "reload" => {
                if let Some(page) = app.get_webview(&label) {
                    if let Ok(current) = page.url() {
                        let _ = page.navigate(current);
                    }
                }
            }
            "address" => {
                let raw = url.unwrap_or_default().trim().to_string();
                if raw.is_empty() {
                    return Err(err("type an address first"));
                }
                let target = crate::computer_subsystem::agent_url_allowed(&raw)?;
                let target_str = target.to_string();
                update_shell_state(&bot_id, |s| {
                    let active = s.active_tab.clone();
                    if let Some(tab) = s.tabs.iter_mut().find(|tab| tab.id == active) {
                        tab.url = target_str.clone();
                        tab.title = url::Url::parse(&target_str)
                            .ok()
                            .and_then(|parsed| parsed.host_str().map(str::to_string))
                            .unwrap_or_else(|| target_str.clone());
                    }
                });
                ensure_chrome(&app, &home, &bot_id, Some(target))?;
                apply_chrome_visibility(&app, &bot_id);
                sync_instance_summary(&app, &bot_id);
            }
            _ => return Err(err("kind must be back, forward, reload, or address")),
        }
        broadcast_shell(&app, &bot_id, "chrome");
        Ok(())
    })
    .await
    .map_err(|e| err(format!("the browser control did not run: {e}")))?
}

/// Recent page navigations for the bot's Chrome (newest first) — the
/// history button in the Chrome app and the chat dock's embedded panel.
#[tauri::command]
pub fn mini_history(webview: Webview<tauri::Wry>, bot_id: Option<String>) -> Result<Vec<String>> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    Ok(crate::computer_subsystem::shell_state(&bot_id).history)
}

// ---------------------------------------------------------------------------
// Sandboxed file explorer — two roots: the bot's workspace (shared with its
// terminal and tools) and its memory library (EXPERIENCE.md and friends).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum FsRoot {
    Workspace,
    Memory,
}

fn resolve_root(home: &std::path::Path, bot_id: &str, root: &str) -> Result<(std::path::PathBuf, FsRoot)> {
    let id = crate::util::safe_id_component(bot_id)?;
    match root {
        "workspace" => Ok((home.join("bots").join(id).join("workspace"), FsRoot::Workspace)),
        "memory" | "library" => Ok((home.join("bots").join(id).join("library"), FsRoot::Memory)),
        _ => Err(err("root must be workspace or memory")),
    }
}

/// Joins a shell-supplied relative path onto the root, refusing escapes.
fn confined(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf> {
    let rel = rel.trim().replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') || part.contains('\\') {
            return Err(err("paths stay inside this bot's files"));
        }
    }
    let joined = root.join(rel);
    if !joined.starts_with(root) {
        return Err(err("paths stay inside this bot's files"));
    }
    Ok(joined)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniFsEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified_ms: u64,
    pub ext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniFsListing {
    pub root: String,
    pub path: String,
    pub absolute_path: String,
    pub entries: Vec<MiniFsEntry>,
}

#[tauri::command]
pub fn mini_fs_list(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, path: String, bot_id: Option<String>) -> Result<MiniFsListing> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let (base, _) = resolve_root(&state.home, &bot_id, &root)?;
    let _ = std::fs::create_dir_all(&base);
    let dir = confined(&base, &path)?;
    if !dir.is_dir() {
        return Err(err("that folder does not exist"));
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| err(e.to_string()))?;
    for item in read.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            std::path::Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        entries.push(MiniFsEntry {
            name,
            kind: if is_dir { "dir".into() } else { "file".into() },
            size: if is_dir { 0 } else { meta.len() },
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            ext,
        });
    }
    entries.sort_by(|a, b| b.kind.cmp(&a.kind).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(MiniFsListing {
        root,
        path,
        absolute_path: dir.to_string_lossy().to_string(),
        entries,
    })
}

const TEXT_EXTS: [&str; 26] = [
    "txt", "md", "json", "ts", "tsx", "js", "jsx", "css", "html", "htm", "py", "rs", "toml", "yaml", "yml", "log", "csv", "env", "gitignore", "sh", "ps1", "bat", "xml", "svg", "ini", "cfg",
];
const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif"];
const MEDIA_EXTS: [&str; 12] = ["mp4", "webm", "mkv", "mov", "avi", "mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniFsRead {
    pub name: String,
    pub kind: String,
    pub mime: String,
    pub size: u64,
    pub truncated: bool,
    pub text: Option<String>,
    pub base64: Option<String>,
}

#[tauri::command]
pub fn mini_fs_read(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, path: String, max_bytes: Option<u64>, want_body: Option<bool>, bot_id: Option<String>) -> Result<MiniFsRead> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let (base, _) = resolve_root(&state.home, &bot_id, &root)?;
    let file = confined(&base, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| err(e.to_string()))?;
    if meta.is_dir() {
        return Err(err("that is a folder"));
    }
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let cap = max_bytes.unwrap_or(262_144).min(8 * 1024 * 1024);
    // Media tools (mediabunny) read the whole file — they pass want_body and
    // a 96 MB cap; the explorer preview never loads media bodies.
    if want_body == Some(true) {
        if meta.len() > 96 * 1024 * 1024 {
            return Err(err("file is over the 96 MB mini-computer tool limit"));
        }
        let bytes = std::fs::read(&file).map_err(|e| err(e.to_string()))?;
        let mime = if ["mp4", "mov", "m4a", "aac"].contains(&ext.as_str()) {
            "video/mp4"
        } else if ext == "webm" {
            "video/webm"
        } else if ext == "mkv" {
            "video/x-matroska"
        } else if IMAGE_EXTS.contains(&ext.as_str()) {
            "image/*"
        } else {
            "application/octet-stream"
        };
        return Ok(MiniFsRead {
            name,
            kind: "media".into(),
            mime: mime.into(),
            size: meta.len(),
            truncated: false,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        });
    }
    if IMAGE_EXTS.contains(&ext.as_str()) {
        let size = meta.len();
        if size > cap {
            return Err(err("image is too large to preview"));
        }
        let bytes = std::fs::read(&file).map_err(|e| err(e.to_string()))?;
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "bmp" => "image/bmp",
            _ => "image/avif",
        };
        return Ok(MiniFsRead {
            name,
            kind: "image".into(),
            mime: mime.into(),
            size,
            truncated: false,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        });
    }
    if MEDIA_EXTS.contains(&ext.as_str()) {
        return Ok(MiniFsRead {
            name,
            kind: "media".into(),
            mime: if ["mp4", "mov", "m4a", "aac"].contains(&ext.as_str()) { "video/mp4".into() } else if ext == "webm" { "video/webm".into() } else if ext == "mkv" { "video/x-matroska".into() } else { "audio/mpeg".into() },
            size: meta.len(),
            truncated: false,
            text: None,
            base64: None,
        });
    }
    let looks_text = TEXT_EXTS.contains(&ext.as_str()) || ext.is_empty() || name.starts_with('.');
    if !looks_text {
        let mut head = [0u8; 8];
        let mut handle = std::fs::File::open(&file).map_err(|e| err(e.to_string()))?;
        use std::io::Read;
        let n = handle.read(&mut head).unwrap_or(0);
        if head[..n].contains(&0) {
            return Ok(MiniFsRead {
                name,
                kind: "binary".into(),
                mime: "application/octet-stream".into(),
                size: meta.len(),
                truncated: false,
                text: None,
                base64: None,
            });
        }
    }
    let size = meta.len();
    let take = (size.min(cap)) as usize;
    let mut bytes = vec![0u8; take];
    {
        let mut handle = std::fs::File::open(&file).map_err(|e| err(e.to_string()))?;
        use std::io::Read;
        handle.read_exact(&mut bytes).map_err(|e| err(e.to_string()))?;
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(MiniFsRead {
        name,
        kind: "text".into(),
        mime: "text/plain".into(),
        size,
        truncated: size > cap,
        text: Some(text),
        base64: None,
    })
}

fn write_inner(state: &crate::AppState, webview: &Webview<tauri::Wry>, root: &str, path: &str, bytes: Vec<u8>, bot_id: Option<String>) -> Result<String> {
    let bot_id = resolve_bot(webview, &bot_id)?;
    let (base, _) = resolve_root(&state.home, &bot_id, root)?;
    let file = confined(&base, path)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(e.to_string()))?;
    }
    std::fs::write(&file, bytes).map_err(|e| err(e.to_string()))?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn mini_fs_write(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, path: String, body: String, bot_id: Option<String>) -> Result<String> {
    write_inner(&state, &webview, &root, &path, body.into_bytes(), bot_id)
}

#[tauri::command]
pub fn mini_fs_write_bytes(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, path: String, base64_body: String, bot_id: Option<String>) -> Result<String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(base64_body.trim())
        .map_err(|e| err(format!("bad payload: {e}")))?;
    if decoded.len() > 96 * 1024 * 1024 {
        return Err(err("file too large to save from the mini computer (96 MB cap)"));
    }
    write_inner(&state, &webview, &root, &path, decoded, bot_id)
}

#[tauri::command]
pub fn mini_fs_mkdir(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, path: String, bot_id: Option<String>) -> Result<String> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let (base, _) = resolve_root(&state.home, &bot_id, &root)?;
    let dir = confined(&base, &path)?;
    std::fs::create_dir_all(&dir).map_err(|e| err(e.to_string()))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn mini_fs_rename(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, from: String, to: String, bot_id: Option<String>) -> Result<String> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let (base, _) = resolve_root(&state.home, &bot_id, &root)?;
    let source = confined(&base, &from)?;
    let target = confined(&base, &to)?;
    std::fs::rename(&source, &target).map_err(|e| err(e.to_string()))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn mini_fs_delete(webview: Webview<tauri::Wry>, state: tauri::State<'_, crate::AppState>, root: String, path: String, bot_id: Option<String>) -> Result<String> {
    let bot_id = resolve_bot(&webview, &bot_id)?;
    let (base, _) = resolve_root(&state.home, &bot_id, &root)?;
    let target = confined(&base, &path)?;
    if target == base {
        return Err(err("cannot delete the root"));
    }
    let removed = if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| err(e.to_string()))?;
        "folder"
    } else {
        std::fs::remove_file(&target).map_err(|e| err(e.to_string()))?;
        "file"
    };
    Ok(format!("Deleted {removed} {}", target.display()))
}

/// The bot's memory library root (EXPERIENCE.md and friends) shown in the
/// Files app as the "Memory" root.
pub fn mini_memory_dir(home: &std::path::Path, bot_id: &str) -> Result<std::path::PathBuf> {
    let id = crate::util::safe_id_component(bot_id)?;
    Ok(home.join("bots").join(id).join("library"))
}
