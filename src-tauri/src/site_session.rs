//! Shared site sign-in for every bot browser.
//!
//! Each bot keeps its own WebView2 profile, because two live webviews cannot
//! lock one user-data folder. After a page loads, that browser copies its
//! cookies into `~/.ronicos/shared-site-session.json`. Before another bot
//! opens a site, those cookies are written into its own profile. A Google
//! Flow sign-in in one bot's browser is then already present in the others.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SharedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(default)]
    pub expires: i64,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub same_site: String,
}

fn jar_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

struct ExportSlot {
    latest: Instant,
    running: bool,
}

fn export_slots() -> std::sync::MutexGuard<'static, HashMap<String, ExportSlot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, ExportSlot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

fn last_exporter() -> std::sync::MutexGuard<'static, String> {
    static LAST: Mutex<String> = Mutex::new(String::new());
    LAST.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn refreshed() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    static DONE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    DONE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

pub fn jar_path(home: &Path) -> PathBuf {
    home.join("shared-site-session.json")
}

/// https and http sites only. The app's own shell hosts are not a sign-in.
pub fn worth_sharing(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else { return false };
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    !matches!(host.as_str(), "localhost" | "127.0.0.1" | "tauri.localhost" | "asset.localhost" | "about")
}

pub fn load_jar(path: &Path) -> Vec<SharedCookie> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_jar(path: &Path, cookies: &[SharedCookie]) -> bool {
    let Ok(text) = serde_json::to_string(cookies) else { return false };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, text).is_ok()
}

fn cookie_key(cookie: &SharedCookie) -> String {
    format!(
        "{}|{}|{}",
        cookie.domain.trim().trim_start_matches('.').to_ascii_lowercase(),
        cookie.path,
        cookie.name
    )
}

/// Incoming cookies replace the same domain + path + name. Empty names are dropped.
pub fn merge_cookies(existing: &mut Vec<SharedCookie>, incoming: Vec<SharedCookie>) {
    let mut index: HashMap<String, usize> = HashMap::new();
    existing.retain(|cookie| !cookie.name.is_empty() && !cookie.domain.is_empty());
    for (i, cookie) in existing.iter().enumerate() {
        index.insert(cookie_key(cookie), i);
    }
    for cookie in incoming {
        if cookie.name.is_empty() || cookie.domain.is_empty() || cookie.value.len() > 8192 {
            continue;
        }
        let key = cookie_key(&cookie);
        if let Some(slot) = index.get(&key).copied() {
            existing[slot] = cookie;
        } else {
            index.insert(key, existing.len());
            existing.push(cookie);
        }
    }
    if existing.len() > 400 {
        let drop_n = existing.len() - 400;
        existing.drain(0..drop_n);
    }
}

fn host_of(raw: &str) -> String {
    url::Url::parse(raw).ok().and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase())).unwrap_or_default()
}

fn domain_covers(domain: &str, host: &str) -> bool {
    let domain = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if domain.is_empty() || host.is_empty() {
        return false;
    }
    host == domain || host.ends_with(&format!(".{domain}"))
}

pub fn jar_covers_url(cookies: &[SharedCookie], raw: &str) -> bool {
    let host = host_of(raw);
    cookies.iter().any(|cookie| domain_covers(&cookie.domain, &host))
}

/// Reload a bot that is already sitting on a site another bot just signed into.
/// Once per webview + host, and never the browser that exported the session.
pub fn should_reload_for_session(label: &str, raw: &str) -> bool {
    if !worth_sharing(raw) {
        return false;
    }
    let cookies = load_jar(&jar_path(&crate::util::product_home()));
    if !jar_covers_url(&cookies, raw) {
        return false;
    }
    let exporter = last_exporter().clone();
    // The browser that just saved the jar already has the session. Reloading
    // it would throw away the page the person is looking at. An empty exporter
    // means the jar was saved earlier (including before this process started)
    // and this browser still has to pick those cookies up.
    if !exporter.is_empty() && exporter == label {
        return false;
    }
    let key = format!("{label}|{}", host_of(raw));
    let mut done = refreshed();
    if done.get(&key).is_some_and(|at| at.elapsed() < Duration::from_secs(30)) {
        return false;
    }
    done.insert(key, Instant::now());
    true
}

fn note_exported(label: &str) {
    *last_exporter() = label.to_string();
}

/// Copy the shared jar into this webview. Returns after the write has run.
pub fn import_shared(webview: &tauri::Webview<tauri::Wry>) -> bool {
    let cookies = load_jar(&jar_path(&crate::util::product_home()));
    if cookies.is_empty() {
        return false;
    }
    apply_cookies(webview, &cookies)
}

/// Read this webview's cookies into the shared jar. Safe to call off the UI thread.
pub fn export_shared(webview: &tauri::Webview<tauri::Wry>, label: &str) {
    let Some(incoming) = read_cookies(webview) else { return };
    if incoming.is_empty() {
        return;
    }
    let _guard = jar_guard();
    let path = jar_path(&crate::util::product_home());
    let mut existing = load_jar(&path);
    merge_cookies(&mut existing, incoming);
    if save_jar(&path, &existing) {
        note_exported(label);
    }
}

/// Coalesced export. Sign-in is a chain of redirects, and the session cookies
/// arrive on the last hop. A worker waits until this webview has been quiet,
/// then reads. The navigation callback is on the UI thread, so the read runs
/// on that worker and only then asks the webview thread for cookies.
pub fn schedule_export(app: &tauri::AppHandle, label: &str) {
    let label = label.to_string();
    {
        let mut slots = export_slots();
        let slot = slots.entry(label.clone()).or_insert(ExportSlot { latest: Instant::now(), running: false });
        slot.latest = Instant::now();
        if slot.running {
            return;
        }
        slot.running = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            let latest = export_slots().get(&label).map(|slot| slot.latest).unwrap_or_else(Instant::now);
            let wait = Duration::from_millis(700).saturating_sub(latest.elapsed());
            if !wait.is_zero() {
                std::thread::sleep(wait);
                continue;
            }
            let Some(view) = app.get_webview(&label) else {
                if let Some(slot) = export_slots().get_mut(&label) {
                    slot.running = false;
                }
                return;
            };
            let started = Instant::now();
            export_shared(&view, &label);
            let mut slots = export_slots();
            let Some(slot) = slots.get_mut(&label) else { return };
            if slot.latest <= started {
                slot.running = false;
                return;
            }
        }
    });
}

fn apply_cookies(webview: &tauri::Webview<tauri::Wry>, cookies: &[SharedCookie]) -> bool {
    let cookies = cookies.to_vec();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let queued = webview.with_webview(move |platform| {
        let applied = apply_on_platform(&platform, &cookies);
        let _ = tx.send(applied);
    });
    if queued.is_err() {
        return false;
    }
    rx.recv_timeout(Duration::from_secs(4)).unwrap_or(false)
}

fn read_cookies(webview: &tauri::Webview<tauri::Wry>) -> Option<Vec<SharedCookie>> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let queued = webview.with_webview(move |platform| {
        let cookies = read_on_platform(&platform);
        let _ = tx.send(cookies);
    });
    if queued.is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_secs(5)).ok()
}

#[cfg(windows)]
fn apply_on_platform(platform: &tauri::webview::PlatformWebview, cookies: &[SharedCookie]) -> bool {
    use windows::core::Interface;
    unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return false };
        let Ok(core) = core.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2>() else { return false };
        let Ok(manager) = core.CookieManager() else { return false };
        let mut applied = false;
        for cookie in cookies {
            if write_one(&manager, cookie) {
                applied = true;
            }
        }
        applied
    }
}

#[cfg(windows)]
fn write_one(manager: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieManager, cookie: &SharedCookie) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
    };
    use windows::core::HSTRING;
    unsafe {
        let name = HSTRING::from(cookie.name.as_str());
        let value = HSTRING::from(cookie.value.as_str());
        let domain = HSTRING::from(cookie.domain.as_str());
        let path = HSTRING::from(if cookie.path.is_empty() { "/" } else { cookie.path.as_str() });
        let Ok(created) = manager.CreateCookie(&name, &value, &domain, &path) else { return false };
        if cookie.expires > 0 {
            let _ = created.SetExpires(cookie.expires as f64);
        }
        let _ = created.SetIsHttpOnly(cookie.http_only);
        let _ = created.SetIsSecure(cookie.secure);
        let kind = match cookie.same_site.as_str() {
            "strict" => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
            "none" => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
            _ => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
        };
        let _ = created.SetSameSite(kind);
        manager.AddOrUpdateCookie(&created).is_ok()
    }
}

#[cfg(windows)]
fn read_on_platform(platform: &tauri::webview::PlatformWebview) -> Vec<SharedCookie> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2CookieList, ICoreWebView2_2};
    use webview2_com::GetCookiesCompletedHandler;
    use windows::core::{Interface, PCWSTR};
    unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return Vec::new() };
        let Ok(core) = core.cast::<ICoreWebView2_2>() else { return Vec::new() };
        let Ok(manager) = core.CookieManager() else { return Vec::new() };
        let (tx, rx) = std::sync::mpsc::channel();
        let handler = GetCookiesCompletedHandler::create(Box::new(move |error, list: Option<ICoreWebView2CookieList>| {
            let parsed = if error.is_err() { Vec::new() } else { parse_cookie_list(list) };
            let _ = tx.send(parsed);
            Ok(())
        }));
        if manager.GetCookies(PCWSTR::null(), &handler).is_err() {
            return Vec::new();
        }
        // The completion is posted back to this UI thread. Pump until it lands.
        webview2_com::wait_with_pump(rx).unwrap_or_default()
    }
}

#[cfg(windows)]
unsafe fn parse_cookie_list(list: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList>) -> Vec<SharedCookie> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT};
    use webview2_com::take_pwstr;
    use windows::core::{BOOL, PWSTR};
    let Some(list) = list else { return Vec::new() };
    let mut count = 0u32;
    if list.Count(&mut count).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for index in 0..count.min(400) {
        let Ok(cookie) = list.GetValueAtIndex(index) else { continue };
        let mut name = PWSTR::null();
        let mut value = PWSTR::null();
        let mut domain = PWSTR::null();
        let mut path = PWSTR::null();
        if cookie.Name(&mut name).is_err() || cookie.Value(&mut value).is_err() || cookie.Domain(&mut domain).is_err() || cookie.Path(&mut path).is_err() {
            continue;
        }
        let name = take_pwstr(name);
        let value = take_pwstr(value);
        let domain = take_pwstr(domain);
        let path = take_pwstr(path);
        if name.is_empty() || domain.is_empty() {
            continue;
        }
        let mut expires = 0.0f64;
        let _ = cookie.Expires(&mut expires);
        let mut http_only: BOOL = false.into();
        let _ = cookie.IsHttpOnly(&mut http_only);
        let mut secure: BOOL = false.into();
        let _ = cookie.IsSecure(&mut secure);
        let mut same = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
        let _ = cookie.SameSite(&mut same);
        let same_site = if same == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT {
            "strict"
        } else if same == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE {
            "none"
        } else {
            "lax"
        };
        out.push(SharedCookie {
            name,
            value,
            domain,
            path: if path.is_empty() { "/".into() } else { path },
            expires: if expires > 0.0 { expires as i64 } else { 0 },
            http_only: http_only.as_bool(),
            secure: secure.as_bool(),
            same_site: same_site.into(),
        });
    }
    out
}

#[cfg(not(windows))]
fn apply_on_platform(_platform: &tauri::webview::PlatformWebview, _cookies: &[SharedCookie]) -> bool {
    false
}

#[cfg(not(windows))]
fn read_on_platform(_platform: &tauri::webview::PlatformWebview) -> Vec<SharedCookie> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str, domain: &str) -> SharedCookie {
        SharedCookie {
            name: name.into(),
            value: value.into(),
            domain: domain.into(),
            path: "/".into(),
            expires: 2_000_000_000,
            http_only: true,
            secure: true,
            same_site: "lax".into(),
        }
    }

    #[test]
    fn merge_replaces_the_same_cookie_and_drops_blanks() {
        let mut jar = vec![cookie("SID", "old", ".google.com")];
        merge_cookies(&mut jar, vec![cookie("SID", "new", ".google.com"), cookie("", "x", ".google.com"), cookie("HSID", "h", ".google.com")]);
        assert_eq!(jar.len(), 2);
        assert_eq!(jar[0].value, "new");
        assert_eq!(jar[1].name, "HSID");
    }

    #[test]
    fn jar_round_trips_and_covers_a_subdomain() {
        let dir = std::env::temp_dir().join(format!("ronic-session-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = jar_path(&dir);
        // accounts.google.com cookies are on .google.com. Google Flow itself
        // is labs.google, which is not under google.com, so its session is a
        // separate host cookie. Both have to round-trip.
        let jar = vec![cookie("SID", "session", ".google.com"), cookie("SID", "flow", "labs.google")];
        assert!(save_jar(&path, &jar));
        let loaded = load_jar(&path);
        assert_eq!(loaded, jar);
        assert!(jar_covers_url(&loaded, "https://accounts.google.com/signin"));
        assert!(jar_covers_url(&loaded, "https://labs.google/fx/tools/flow"));
        assert!(!jar_covers_url(&vec![cookie("SID", "session", ".google.com")], "https://labs.google/fx/tools/flow"));
        assert!(!jar_covers_url(&loaded, "https://example.com/"));
        assert!(worth_sharing("https://labs.google/fx/tools/flow"));
        assert!(!worth_sharing("about:blank"));
        assert!(!worth_sharing("http://localhost:1420/"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
