//! Shared setup for Claude, ChatGPT, and the other site windows.
//!
//! Google and Apple reject WebView2, so those pages open in installed Chrome or Edge.
//! Chrome or Edge is started with this site's EBWebView folder as its profile.
//! The panel closes first, because both cannot use that folder at once, and
//! opens again when the browser releases it. OpenAI sign-in stays in the panel.
//! The user's everyday Chrome profile is never used. Folder generation p2
//! leaves a profile that only rendered a blank page behind.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::webview::{NewWindowFeatures, NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const SHELL_SCRIPT: &str = include_str!("site_shell.js");

/// Wry's own defaults, plus the storage features that break a sign-in cookie.
/// UserAgentClientHint stays on. Google treats a browser with no client hints,
/// or with a hint brand of "Microsoft Edge WebView2", as not secure.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ThirdPartyStoragePartitioning,TrackingPrevention";
/// New folder generation. Popups share it with the panel. Older folders stay on disk.
const PROFILE_STAMP: &str = "p2";

static POPUP_SEQ: AtomicU64 = AtomicU64::new(1);
static LAST_BROWSER_HANDOFF: Mutex<Option<Instant>> = Mutex::new(None);
static RESTORE_AT: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

fn sign_ins() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    static MAP: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

fn suppress_auth_map() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

pub fn user_agent() -> &'static str {
    static UA: OnceLock<String> = OnceLock::new();
    UA.get_or_init(|| {
        let major = runtime_version().major;
        // Reduced Edge UA. The same major is in the Edg/ token and the client hints.
        format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0")
    })
    .as_str()
}

pub fn profile_dir(home: &Path, label: &str) -> PathBuf {
    let mut safe = String::new();
    for ch in label.chars().take(64) {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            safe.push(ch);
        } else {
            safe.push('_');
        }
    }
    if safe.is_empty() {
        safe.push_str("site");
    }
    home.join("webapps").join("browser").join(format!("{safe}-{PROFILE_STAMP}"))
}

pub fn webapp_home(label: &str) -> Option<&'static str> {
    let id = label.strip_prefix("webapp_")?;
    Some(match id {
        "chatgpt" => "https://chatgpt.com/",
        "claude" => "https://claude.ai/",
        "gemini" => "https://gemini.google.com/",
        "grok" => "https://grok.com/",
        "openrouter" => "https://openrouter.ai/keys",
        "deepseek" => "https://chat.deepseek.com/",
        "qwen" => "https://chat.qwen.ai/",
        "tokenrouter" => "https://tokenrouter.io/",
        "bedrock" => "https://console.aws.amazon.com/bedrock",
        "nvidia" => "https://build.nvidia.com/",
        "meta" => "https://meta.ai/",
        "mistral" => "https://chat.mistral.ai/",
        "perplexity" => "https://www.perplexity.ai/",
        "groq" => "https://console.groq.com/keys",
        "together" => "https://api.together.ai/settings/api-keys",
        "cohere" => "https://dashboard.cohere.com/api-keys",
        "copilot" => "https://copilot.microsoft.com/",
        _ => return None,
    })
}

pub fn url_is_blank(url: &Url) -> bool {
    url.scheme() == "about" || url.as_str().eq_ignore_ascii_case("about:blank")
}

pub fn ensure_profile(home: &Path, label: &str) -> std::io::Result<PathBuf> {
    let dir = profile_dir(home, label);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn site_window<'a, R, M>(builder: WebviewWindowBuilder<'a, R, M>, profile: PathBuf, app: AppHandle<R>, owner_label: String) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    let popup_profile = profile.clone();
    let popup_owner = owner_label.clone();
    let nav_app = app.clone();
    let nav_profile = profile.clone();
    let nav_label = owner_label.clone();
    builder
        .user_agent(user_agent())
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script_for_all_frames(SHELL_SCRIPT)
        .initialization_script(crate::workspace_bridge::PAGE_SCRIPT)
        .data_directory(profile)
        .enable_clipboard_access()
        .on_navigation(move |url| !block_embedded_auth(&nav_app, &nav_label, &nav_profile, url, ""))
        .on_new_window(move |url, features| {
            let owner = app.get_webview_window(&popup_owner);
            open_auth_popup(&app, owner.as_ref(), url, features, popup_profile.clone(), popup_owner.clone(), String::new())
        })
}

pub fn site_child<R: Runtime>(builder: WebviewBuilder<R>, profile: PathBuf, app: AppHandle<R>, child_label: String, home_url: String) -> WebviewBuilder<R> {
    let popup_profile = profile.clone();
    let popup_app = app.clone();
    let popup_label = child_label.clone();
    let popup_home = home_url.clone();
    let nav_app = app;
    let nav_profile = profile.clone();
    let nav_label = child_label;
    let nav_home = home_url;
    builder
        .user_agent(user_agent())
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script_for_all_frames(SHELL_SCRIPT)
        .initialization_script(crate::workspace_bridge::PAGE_SCRIPT)
        .data_directory(profile)
        .enable_clipboard_access()
        .on_navigation(move |url| !block_embedded_auth(&nav_app, &nav_label, &nav_profile, url, &nav_home))
        .on_new_window(move |url, features| {
            let owner = popup_app.get_webview_window("main");
            open_auth_popup(&popup_app, owner.as_ref(), url, features, popup_profile.clone(), popup_label.clone(), popup_home.clone())
        })
}

/// Make this webview answer Google's secure-browser check as Edge.
/// `reload_auth` retries a sign-in page that was already requested as WebView2.
pub fn prepare_sign_in<R: Runtime>(webview: &tauri::Webview<R>, reload_auth: bool) {
    #[cfg(windows)]
    {
        let _ = webview.with_webview(|platform| apply_client_hints(&platform.controller()));
        if reload_auth {
            watch_auth_reload(webview.clone());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, reload_auth);
    }
}

/// Open a site in the real browser. Google accepts that sign-in; it rejects the
/// same page inside WebView2. The call does not read or copy browser cookies.
pub fn open_system_browser(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !allowed_browser_url(url) {
        return Err("that page cannot be opened from here".into());
    }
    #[cfg(windows)]
    {
        // ShellExecuteW keeps the query string intact. The default browser is
        // first. Edge is only the fallback when that open fails.
        if shell_open(url).is_ok() {
            return Ok(());
        }
        let edge = format!("microsoft-edge:{url}");
        return shell_open(&edge);
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn open_auth_popup<R: Runtime>(
    app: &AppHandle<R>,
    owner: Option<&WebviewWindow<R>>,
    url: Url,
    features: NewWindowFeatures,
    profile: PathBuf,
    child_label: String,
    home_url: String,
) -> NewWindowResponse<R> {
    // Google and Apple reject this webview. Open them in Chrome or Edge on
    // this same profile. OpenAI and the site's own login page stay here.
    if embedded_auth_blocked(&url) {
        if !child_label.is_empty() {
            let name = sign_in_name(&child_label);
            schedule_browser_sign_in(app.clone(), child_label, profile, url.to_string(), home_url, name);
        } else {
            let _ = hand_off_embedded_auth(&url);
        }
        return NewWindowResponse::Deny;
    }
    if !child_label.is_empty() && panel_login(&url) {
        if let Some(view) = app.get_webview(&child_label) {
            let _ = view.navigate(url);
            return NewWindowResponse::Deny;
        }
    }
    if hand_off_embedded_auth(&url) || !allowed_popup(&url) {
        schedule_restore(app.clone(), child_label, home_url);
        return NewWindowResponse::Deny;
    }
    let label = fresh_label(app);
    let restore_size = features.size().map(|size| size.width < 240.0 || size.height < 240.0).unwrap_or(false);
    let nested_app = app.clone();
    let nested_profile = profile.clone();
    let nested_child = child_label.clone();
    let nested_home = home_url.clone();
    let nested_popup = label.clone();
    let nav_app = app.clone();
    let nav_child = child_label.clone();
    let nav_home = home_url.clone();
    let nav_popup = label.clone();
    let target = url.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("Sign in")
        .inner_size(540.0, 760.0)
        .user_agent(user_agent())
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script_for_all_frames(SHELL_SCRIPT)
        .data_directory(profile)
        .window_features(features)
        .on_navigation(move |next| {
            // Cancelling Google here leaves about:blank and opens Edge or
            // Chrome, whose cookies never come back to this profile.
            if login_landed(&next) {
                finish_embedded_login(nav_app.clone(), nav_child.clone(), nav_home.clone(), nav_popup.clone());
            }
            true
        })
        .on_document_title_changed(|window, title| {
            let trimmed = title.trim();
            if !trimmed.is_empty() && trimmed.chars().count() <= 180 {
                let _ = window.set_title(trimmed);
            }
        })
        .on_new_window(move |next, next_features| {
            let parent = nested_app.get_webview_window(&nested_popup);
            open_auth_popup(&nested_app, parent.as_ref(), next, next_features, nested_profile.clone(), nested_child.clone(), nested_home.clone())
        })
        .focused(true)
        .visible(true);
    if restore_size {
        builder = builder.inner_size(540.0, 760.0);
    }
    #[cfg(windows)]
    if let Some(owner) = owner {
        if let Ok(hwnd) = owner.hwnd() {
            builder = builder.owner_raw(hwnd);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = owner;
    }
    match builder.build() {
        Ok(window) => {
            if let Some(view) = app.get_webview(window.label()) {
                prepare_sign_in(&view, false);
            }
            NewWindowResponse::Create { window }
        }
        Err(error) => {
            eprintln!("sign-in window did not open: {error}");
            // Allow would open a window on a different profile, so the panel
            // would stay signed out after a login that looked successful.
            if !child_label.is_empty() {
                if let Some(view) = app.get_webview(&child_label) {
                    let _ = view.navigate(target);
                }
                return NewWindowResponse::Deny;
            }
            NewWindowResponse::Deny
        }
    }
}

fn hand_off_embedded_auth(url: &Url) -> bool {
    if !embedded_auth_blocked(url) {
        return false;
    }
    let now = Instant::now();
    let mut slot = LAST_BROWSER_HANDOFF.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let recent = slot.is_some_and(|then| now.duration_since(then) < Duration::from_secs(4));
    if !recent {
        *slot = Some(now);
        drop(slot);
        let target = url.to_string();
        // ShellExecute on the webview thread is what makes the window show
        // "(Not Responding)" while Edge or Chrome is opening.
        std::thread::spawn(move || {
            let _ = open_system_browser(&target);
        });
    }
    true
}

fn login_landed(url: &Url) -> bool {
    if !crate::workspace_bridge::chat_page_url(url) {
        return false;
    }
    let path = url.path().to_ascii_lowercase();
    !path.contains("auth") && !path.contains("login") && !path.contains("signin") && !path.contains("sign-in")
}

fn allow_restore(label: &str) -> bool {
    if label.is_empty() {
        return false;
    }
    let now = Instant::now();
    let mut slot = RESTORE_AT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    slot.retain(|(_, at)| now.duration_since(*at) < Duration::from_secs(20));
    if slot.iter().any(|(name, _)| name == label) {
        return false;
    }
    slot.push((label.to_string(), now));
    true
}

fn go_view<R: Runtime>(app: &AppHandle<R>, label: &str, home: &str) {
    let Some(view) = app.get_webview(label) else {
        return;
    };
    if let Ok(parsed) = Url::parse(home) {
        if view.navigate(parsed).is_ok() {
            return;
        }
    }
    let literal = serde_json::to_string(home).unwrap_or_else(|_| "\"about:blank\"".into());
    let _ = view.eval(&format!("location.replace({literal})"));
}

pub fn schedule_restore<R: Runtime>(app: AppHandle<R>, label: String, home: String) {
    if label.is_empty() || home.is_empty() || !allow_restore(&label) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        let Some(view) = app.get_webview(&label) else {
            return;
        };
        let stuck = view.url().ok().is_none_or(|url| url_is_blank(&url));
        if stuck {
            go_view(&app, &label, &home);
        }
    });
}

fn finish_embedded_login<R: Runtime>(app: AppHandle<R>, child_label: String, home: String, popup_label: String) {
    if !allow_restore(&format!("login:{popup_label}")) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        if !home.is_empty() {
            go_view(&app, &child_label, &home);
        } else if let Some(window) = app.get_webview_window(&child_label) {
            let _ = window.eval("location.reload()");
        }
        if let Some(popup) = app.get_webview_window(&popup_label) {
            let _ = popup.close();
        }
    });
}

pub fn recover_blank_webapps<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    for view in window.webviews() {
        let label = view.label().to_string();
        let Some(home) = webapp_home(&label) else {
            continue;
        };
        let Ok(url) = view.url() else {
            continue;
        };
        // A Google or OpenAI page is the login itself. Only a blank document
        // is put back on the app home, otherwise the sign-in is interrupted.
        if !url_is_blank(&url) {
            continue;
        }
        if !allow_restore(&label) {
            continue;
        }
        go_view(app, &label, home);
    }
}

/// Login that has to finish in the panel's own profile.
/// Google and Apple are not included. WebView2 cannot complete those.
fn panel_login(url: &Url) -> bool {
    if url.scheme() != "https" || embedded_auth_blocked(url) {
        return false;
    }
    let host = url.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    if host == "auth.openai.com" || host.ends_with(".auth.openai.com") {
        return true;
    }
    let path = url.path().to_ascii_lowercase();
    let auth_path = path.starts_with("/auth")
        || path.contains("/login")
        || path.contains("/signin")
        || path.contains("/sign-in")
        || path.contains("/oauth")
        || path.contains("/authorize");
    if !auth_path {
        return false;
    }
    host == "openai.com"
        || host.ends_with(".openai.com")
        || host == "chatgpt.com"
        || host.ends_with(".chatgpt.com")
        || host == "chat.openai.com"
        || host == "claude.ai"
        || host.ends_with(".claude.ai")
        || host == "gemini.google.com"
        || host == "grok.com"
        || host.ends_with(".grok.com")
}

pub(crate) fn embedded_auth_blocked(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "accounts.google.com"
        || host == "accounts.youtube.com"
        || host == "appleid.apple.com"
        || host.ends_with(".accounts.google.com")
        || host.ends_with(".appleid.apple.com")
}

fn allowed_browser_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    match parsed.scheme() {
        "https" => true,
        "http" => matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }
    let operation = wide("open");
    let file = wide(target);
    let code = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    if code <= 32 {
        Err(format!("could not open the browser (Windows code {code})"))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(hwnd: *mut std::ffi::c_void, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> isize;
}

fn allowed_popup(url: &Url) -> bool {
    match url.scheme() {
        "https" => true,
        "about" => url.path() == "blank",
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

fn fresh_label<R: Runtime>(app: &AppHandle<R>) -> String {
    for _ in 0..24 {
        let n = POPUP_SEQ.fetch_add(1, Ordering::Relaxed);
        let label = format!("omni_auth_{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
    format!("omni_auth_{}", POPUP_SEQ.fetch_add(1, Ordering::Relaxed))
}

struct RuntimeVersion {
    major: u32,
    full: String,
}

fn runtime_version() -> &'static RuntimeVersion {
    static VERSION: OnceLock<RuntimeVersion> = OnceLock::new();
    VERSION.get_or_init(detect_runtime_version)
}

fn detect_runtime_version() -> RuntimeVersion {
    let mut roots = vec![
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application"),
        PathBuf::from(r"C:\Program Files\Microsoft\EdgeWebView\Application"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Microsoft").join("EdgeWebView").join("Application"));
    }
    let mut best: Option<(u32, u32, u32, u32)> = None;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let text = entry.file_name();
            let text = text.to_string_lossy();
            let Some(parsed) = parse_runtime_version(&text) else { continue };
            if !entry.path().join("msedgewebview2.exe").is_file() {
                continue;
            }
            if best.map(|current| parsed > current).unwrap_or(true) {
                best = Some(parsed);
            }
        }
    }
    match best {
        Some((major, minor, build, patch)) => RuntimeVersion { major, full: format!("{major}.{minor}.{build}.{patch}") },
        None => RuntimeVersion { major: 131, full: "131.0.0.0".into() },
    }
}

fn parse_runtime_version(text: &str) -> Option<(u32, u32, u32, u32)> {
    let mut parts = text.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    if !(100..400).contains(&major) {
        return None;
    }
    let minor = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    let build = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, build, patch))
}

fn platform_version() -> String {
    #[cfg(windows)]
    {
        platform_version_windows()
    }
    #[cfg(not(windows))]
    {
        "0.0.0".into()
    }
}

#[cfg(windows)]
fn platform_version_windows() -> String {
    const HKEY_LOCAL_MACHINE: isize = 0x80000002u32 as i32 as isize;
    const RRF_RT_REG_DWORD: u32 = 0x0000_0010;
    const RRF_SUBKEY_WOW6464KEY: u32 = 0x0001_0000;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(hkey: isize, subkey: *const u16, value: *const u16, flags: u32, typ: *mut u32, data: *mut core::ffi::c_void, size: *mut u32) -> i32;
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let sub = wide(r"SOFTWARE\Microsoft\WindowsRuntime\WellKnownContracts");
    let name = wide("Windows.Foundation.UniversalApiContract");
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let mut typ = 0u32;
    let code = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, sub.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, &mut typ, &mut data as *mut u32 as *mut _, &mut size) };
    if code == 0 {
        let major = data >> 16;
        let minor = data & 0xffff;
        if (1..100).contains(&major) {
            return format!("{major}.{minor}.0");
        }
    }
    "15.0.0".into()
}

fn grease_brand(seed: u32, full: bool) -> (String, String) {
    const CHARS: [&str; 11] = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
    const VERSIONS: [&str; 3] = ["8", "99", "24"];
    let brand = format!("Not{}A{}Brand", CHARS[(seed as usize) % CHARS.len()], CHARS[((seed + 1) as usize) % CHARS.len()]);
    let version = VERSIONS[(seed as usize) % VERSIONS.len()];
    let version = if full { format!("{version}.0.0.0") } else { version.to_string() };
    (brand, version)
}

fn shuffle_brands(items: Vec<serde_json::Value>, seed: u32) -> Vec<serde_json::Value> {
    const ORDERS: [[usize; 3]; 6] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let order = ORDERS[(seed as usize) % ORDERS.len()];
    let mut out = vec![serde_json::Value::Null; items.len()];
    for (index, item) in items.into_iter().enumerate() {
        out[order[index]] = item;
    }
    out
}

fn brand_list(seed: u32, version: &str, full: bool) -> Vec<serde_json::Value> {
    let (grease, grease_version) = grease_brand(seed, full);
    shuffle_brands(
        vec![
            serde_json::json!({ "brand": grease, "version": grease_version }),
            serde_json::json!({ "brand": "Chromium", "version": version }),
            serde_json::json!({ "brand": "Microsoft Edge", "version": version }),
        ],
        seed,
    )
}

fn client_hint_params() -> String {
    let runtime = runtime_version();
    let major = runtime.major.to_string();
    let params = serde_json::json!({
        "userAgent": user_agent(),
        "acceptLanguage": "en-US,en;q=0.9",
        "platform": "Win32",
        "userAgentMetadata": {
            "brands": brand_list(runtime.major, &major, false),
            "fullVersionList": brand_list(runtime.major, &runtime.full, true),
            "fullVersion": runtime.full,
            "platform": "Windows",
            "platformVersion": platform_version(),
            "architecture": "x86",
            "model": "",
            "mobile": false,
            "bitness": "64",
            "wow64": false
        }
    });
    params.to_string()
}

#[cfg(windows)]
fn apply_client_hints(controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    let core = match unsafe { controller.CoreWebView2() } {
        Ok(core) => core,
        Err(error) => {
            eprintln!("sign-in browser identity was not applied: {error}");
            return;
        }
    };
    let method = HSTRING::from("Emulation.setUserAgentOverride");
    let params = HSTRING::from(client_hint_params());
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_code, _result| Ok(())));
    if let Err(error) = unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) } {
        eprintln!("sign-in browser identity was not applied: {error}");
    }
}

#[cfg(windows)]
fn watch_auth_reload<R: Runtime>(view: tauri::Webview<R>) {
    let label = view.label().to_string();
    if !allow_restore(&format!("ua-watch:{label}")) {
        return;
    }
    std::thread::spawn(move || {
        for wait_ms in [500u64, 700, 900] {
            std::thread::sleep(Duration::from_millis(wait_ms));
            let Ok(url) = view.url() else { continue };
            if url_is_blank(&url) {
                continue;
            }
            if !embedded_auth_blocked(&url) {
                return;
            }
            if view.reload().is_ok() {
                return;
            }
        }
    });
}

fn sign_in_name(label: &str) -> String {
    let id = label.strip_prefix("webapp_").unwrap_or("");
    match id {
        "chatgpt" => "ChatGPT",
        "claude" => "Claude",
        "gemini" => "Gemini",
        "grok" => "Grok",
        "openrouter" => "OpenRouter",
        "deepseek" => "DeepSeek",
        "qwen" => "Qwen",
        "tokenrouter" => "TokenRouter",
        "bedrock" => "Bedrock",
        "nvidia" => "NVIDIA",
        "meta" => "Meta AI",
        "mistral" => "Mistral",
        "perplexity" => "Perplexity",
        "groq" => "Groq",
        "together" => "Together",
        "cohere" => "Cohere",
        "copilot" => "Copilot",
        _ => "this site",
    }
    .to_string()
}

fn panel_id(label: &str) -> &str {
    label.strip_prefix("webapp_").unwrap_or(label)
}

fn auth_suppressed(label: &str) -> bool {
    let now = Instant::now();
    let mut map = suppress_auth_map();
    map.retain(|_, until| *until > now);
    map.get(label).is_some_and(|until| *until > now)
}

fn suppress_auth(label: &str, dur: Duration) {
    let until = Instant::now() + dur;
    suppress_auth_map().insert(label.to_string(), until);
}

pub(crate) fn browser_sign_in_message(label: &str) -> Option<String> {
    sign_ins().get(label).cloned()
}

/// True when this navigation must not stay inside WebView2.
fn block_embedded_auth<R: Runtime>(app: &AppHandle<R>, label: &str, profile: &Path, url: &Url, home_url: &str) -> bool {
    if !embedded_auth_blocked(url) {
        return false;
    }
    if !auth_suppressed(label) {
        schedule_browser_sign_in(app.clone(), label.to_string(), profile.to_path_buf(), url.to_string(), home_url.to_string(), sign_in_name(label));
    }
    true
}

/// Close the panel and finish Google or Apple sign-in in Chrome or Edge.
/// The browser uses this site's EBWebView directory, so the session is still
/// here when that window closes. A second call while one is open does nothing.
pub(crate) fn schedule_browser_sign_in<R: Runtime>(app: AppHandle<R>, label: String, profile: PathBuf, auth_url: String, home_url: String, app_name: String) {
    if label.is_empty() || auth_suppressed(&label) {
        return;
    }
    let Ok(parsed) = Url::parse(&auth_url) else {
        return;
    };
    if !embedded_auth_blocked(&parsed) {
        return;
    }
    let message = format!("Sign in in the browser window, then close it so {app_name} can continue.");
    {
        let mut map = sign_ins();
        if map.contains_key(&label) {
            return;
        }
        map.insert(label.clone(), message);
    }
    std::thread::spawn(move || run_browser_sign_in(app, label, profile, auth_url, home_url, app_name));
}

/// If the panel was restored straight onto Google's error page, hand it off.
/// Returns true when a browser window is being opened.
pub(crate) fn handoff_if_blocked<R: Runtime>(app: &AppHandle<R>, label: &str, profile: &Path, url: &Url, home_url: &str, app_name: &str) -> bool {
    if !embedded_auth_blocked(url) || auth_suppressed(label) {
        return false;
    }
    schedule_browser_sign_in(app.clone(), label.to_string(), profile.to_path_buf(), url.to_string(), home_url.to_string(), app_name.to_string());
    browser_sign_in_message(label).is_some()
}

pub(crate) fn watch_panel<R: Runtime>(app: AppHandle<R>, label: String, profile: PathBuf, home: String, name: String) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        let Some(view) = app.get_webview(&label) else {
            return;
        };
        let Ok(url) = view.url() else {
            return;
        };
        if url_is_blank(&url) || (embedded_auth_blocked(&url) && auth_suppressed(&label)) {
            if let Ok(parsed) = Url::parse(&home) {
                if !embedded_auth_blocked(&parsed) {
                    let _ = view.navigate(parsed);
                }
            }
            return;
        }
        if embedded_auth_blocked(&url) {
            schedule_browser_sign_in(app, label, profile, url.to_string(), home, name);
        }
    });
}

pub(crate) fn profile_in_use(profile: &Path) -> bool {
    lock_held(&profile.join("EBWebView").join("lockfile"))
}

fn run_browser_sign_in<R: Runtime>(app: AppHandle<R>, label: String, profile: PathBuf, auth_url: String, home_url: String, app_name: String) {
    std::thread::sleep(Duration::from_millis(150));
    let Some((browser_path, browser_name)) = installed_browser() else {
        close_profile_views(&app, &label);
        finish_sign_in(&app, &label, "Install Chrome or Edge, then try signing in again.", false, &home_url);
        return;
    };
    let message = format!("Sign in in the {browser_name} window, then close it so {app_name} can continue.");
    set_sign_in_message(&app, &label, &message);
    close_profile_views(&app, &label);
    let data_dir = profile.join("EBWebView");
    let _ = std::fs::create_dir_all(&data_dir);
    let lock = data_dir.join("lockfile");
    if !wait_lock(&lock, false, Duration::from_secs(10)) {
        finish_sign_in(&app, &label, &format!("Close the {browser_name} sign-in window, then open {app_name} again."), false, &home_url);
        return;
    }
    let script = match browser_launch_script(&browser_path, &data_dir, &auth_url) {
        Ok(body) => body,
        Err(_) => {
            finish_sign_in(&app, &label, "That sign-in page cannot be opened from here.", true, &home_url);
            return;
        }
    };
    let script_path = script_file();
    if std::fs::write(&script_path, script).is_err() {
        finish_sign_in(&app, &label, &format!("{browser_name} did not open. Try signing in again."), true, &home_url);
        return;
    }
    if !launch_script(&script_path) {
        let _ = std::fs::remove_file(&script_path);
        finish_sign_in(&app, &label, &format!("{browser_name} did not open. Try signing in again."), true, &home_url);
        return;
    }
    if !wait_lock(&lock, true, Duration::from_secs(20)) {
        let _ = std::fs::remove_file(&script_path);
        finish_sign_in(&app, &label, &format!("The {browser_name} sign-in window did not open. Try again."), true, &home_url);
        return;
    }
    let _ = std::fs::remove_file(&script_path);
    if !wait_lock(&lock, false, Duration::from_secs(20 * 60)) {
        finish_sign_in(&app, &label, &format!("Close the {browser_name} sign-in window, then open {app_name} again."), false, &home_url);
        return;
    }
    suppress_auth(&label, Duration::from_secs(12));
    finish_sign_in(&app, &label, &format!("{app_name} is opening again."), true, &home_url);
}

fn finish_sign_in<R: Runtime>(app: &AppHandle<R>, label: &str, message: &str, restore: bool, home_url: &str) {
    tell_sign_in(app, label, message);
    clear_sign_in(label);
    if restore {
        restore_panel(app, label, home_url);
    }
}

fn set_sign_in_message<R: Runtime>(app: &AppHandle<R>, label: &str, message: &str) {
    {
        let mut map = sign_ins();
        if let Some(slot) = map.get_mut(label) {
            *slot = message.to_string();
        }
    }
    tell_sign_in(app, label, message);
}

fn clear_sign_in(label: &str) {
    sign_ins().remove(label);
}

fn tell_sign_in<R: Runtime>(app: &AppHandle<R>, label: &str, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let id = serde_json::to_string(panel_id(label)).unwrap_or_else(|_| "\"\"".into());
    let text = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into());
    let js = format!("window.dispatchEvent(new CustomEvent('omni-signin', {{ detail: {{ id: {id}, message: {text} }} }}))");
    let _ = window.eval(js);
}

fn close_profile_views<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let mut labels = vec![label.to_string()];
    labels.extend(app.webviews().keys().filter(|name| name.starts_with("omni_auth_")).cloned());
    for name in labels {
        if let Some(window) = app.get_webview_window(&name) {
            let _ = window.close();
        } else if let Some(view) = app.get_webview(&name) {
            let _ = view.close();
        }
    }
}

fn restore_panel<R: Runtime>(app: &AppHandle<R>, label: &str, home_url: &str) {
    if !label.starts_with("webapp_") || !crate::workspace_apps::panel_wanted(label) {
        return;
    }
    let Some(id) = label.strip_prefix("webapp_") else {
        return;
    };
    let bounds = crate::workspace_apps::stored_bounds(label).unwrap_or(crate::workspace_apps::WebAppBounds { x: 80.0, y: 80.0, width: 960.0, height: 720.0 });
    let home = crate::util::product_home();
    let url = if home_url.is_empty() { None } else { Some(home_url) };
    let _ = crate::workspace_apps::show(app, &home, id, bounds, true, url, None);
}

fn browser_candidates() -> Vec<(PathBuf, &'static str)> {
    let mut found = vec![
        (PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), "Chrome"),
        (PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"), "Chrome"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        found.push((PathBuf::from(local).join("Google").join("Chrome").join("Application").join("chrome.exe"), "Chrome"));
    }
    found.push((PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"), "Edge"));
    found.push((PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"), "Edge"));
    found
}

fn installed_browser() -> Option<(PathBuf, &'static str)> {
    browser_candidates().into_iter().find(|(path, _)| path.is_file())
}

fn vbs_safe(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8000 && !value.chars().any(|ch| ch == '"' || ch == '^' || ch.is_control())
}

fn path_token(path: &Path) -> Result<String, &'static str> {
    let text = path.display().to_string();
    if !vbs_safe(&text) {
        return Err("path");
    }
    Ok(text)
}

fn is_profile_data_dir(path: &Path) -> bool {
    if path.file_name().and_then(|name| name.to_str()) != Some("EBWebView") {
        return false;
    }
    let lower = path.display().to_string().to_ascii_lowercase();
    !lower.contains("\\user data") && !lower.contains("/user data")
}

/// A hidden script so Explorer can start Chrome outside this process's job.
/// `cmd /c start` would split the sign-in URL on `&` and expand `%`.
fn browser_launch_script(browser: &Path, data_dir: &Path, url: &str) -> Result<String, &'static str> {
    if !is_profile_data_dir(data_dir) || !vbs_safe(url) {
        return Err("profile");
    }
    let Ok(parsed) = Url::parse(url) else {
        return Err("url");
    };
    if !embedded_auth_blocked(&parsed) {
        return Err("url");
    }
    let browser = path_token(browser)?;
    let dir = path_token(data_dir)?;
    let command = format!("\"{browser}\" --user-data-dir=\"{dir}\" --no-first-run --no-default-browser-check --new-window \"{url}\"");
    let escaped = command.replace('"', "\"\"");
    Ok(format!("Set shell = CreateObject(\"Wscript.Shell\")\r\nshell.Run \"{escaped}\", 1, False\r\n"))
}

fn script_file() -> PathBuf {
    let n = POPUP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("omni-signin-{}-{n}.vbs", std::process::id()))
}

#[cfg(windows)]
fn launch_script(path: &Path) -> bool {
    std::process::Command::new("explorer.exe").arg(path).spawn().is_ok()
}

#[cfg(not(windows))]
fn launch_script(path: &Path) -> bool {
    let _ = path;
    false
}

fn wait_lock(path: &Path, want_held: bool, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if lock_held(path) == want_held {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(windows)]
fn lock_held(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    if !path.is_file() {
        return false;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let handle = unsafe { CreateFileW(wide.as_ptr(), 0x8000_0000, 0, std::ptr::null_mut(), 3, 0x80, std::ptr::null_mut()) };
    if handle == usize::MAX as *mut std::ffi::c_void {
        let err = unsafe { GetLastError() };
        return err == 32 || err == 33;
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    false
}

#[cfg(not(windows))]
fn lock_held(_path: &Path) -> bool {
    false
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(name: *const u16, access: u32, share: u32, security: *mut std::ffi::c_void, disposition: u32, flags: u32, template: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_and_apple_sign_in_use_the_installed_browser() {
        let google = Url::parse("https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fchatgpt.com%2F").unwrap();
        assert!(embedded_auth_blocked(&google));
        assert!(!panel_login(&google));
        assert!(!panel_login(&Url::parse("https://accounts.youtube.com/").unwrap()));
        assert!(!panel_login(&Url::parse("https://appleid.apple.com/auth/authorize").unwrap()));
        assert!(!panel_login(&Url::parse("https://accounts.google.com.").unwrap()));
        assert!(!embedded_auth_blocked(&Url::parse("https://auth.openai.com/authorize").unwrap()));
        assert!(panel_login(&Url::parse("https://auth.openai.com/authorize").unwrap()));
        assert!(panel_login(&Url::parse("https://chatgpt.com/auth/login").unwrap()));
        assert!(!panel_login(&Url::parse("https://chatgpt.com/").unwrap()));
        assert!(!panel_login(&Url::parse("about:blank").unwrap()));
        assert!(!panel_login(&Url::parse("https://example.com/login").unwrap()));
        assert!(!embedded_auth_blocked(&Url::parse("https://chatgpt.com/").unwrap()));
        assert!(!embedded_auth_blocked(&Url::parse("https://claude.ai/login").unwrap()));
        assert!(!embedded_auth_blocked(&Url::parse("https://myaccount.google.com/").unwrap()));
    }

    #[test]
    fn profile_generation_leaves_the_old_folder_behind() {
        let dir = profile_dir(Path::new("home"), "webapp_chatgpt");
        assert_eq!(dir, PathBuf::from("home").join("webapps").join("browser").join("webapp_chatgpt-p2"));
    }

    #[test]
    fn blank_and_home_pages_are_distinct() {
        assert!(url_is_blank(&Url::parse("about:blank").unwrap()));
        assert!(!url_is_blank(&Url::parse("https://chatgpt.com/").unwrap()));
        assert_eq!(webapp_home("webapp_chatgpt"), Some("https://chatgpt.com/"));
        assert_eq!(webapp_home("harness_chatgpt"), None);
        assert!(login_landed(&Url::parse("https://chatgpt.com/").unwrap()));
        assert!(!login_landed(&Url::parse("https://chatgpt.com/auth/login").unwrap()));
        assert!(!login_landed(&Url::parse("https://auth.openai.com/authorize").unwrap()));
    }

    #[test]
    fn sign_in_identity_is_edge_without_a_webview_brand() {
        let agent = user_agent();
        assert!(agent.contains("Chrome/"));
        assert!(agent.contains("Edg/"));
        assert!(!agent.to_ascii_lowercase().contains("webview"));
        assert!(!BROWSER_ARGS.contains("UserAgentClientHint"));
        assert!(BROWSER_ARGS.contains("ThirdPartyStoragePartitioning"));
        let (brand, version) = grease_brand(155, false);
        assert_eq!(brand, "Not(A:Brand");
        assert_eq!(version, "24");
        let params: serde_json::Value = serde_json::from_str(&client_hint_params()).unwrap();
        let brands = params["userAgentMetadata"]["brands"].as_array().unwrap();
        assert_eq!(brands.len(), 3);
        assert!(brands.iter().any(|item| item["brand"] == "Microsoft Edge"));
        assert!(brands.iter().any(|item| item["brand"] == "Chromium"));
        assert!(!params.to_string().to_ascii_lowercase().contains("webview"));
        assert_eq!(params["userAgent"], agent);
        assert_eq!(params["platform"], "Win32");
        assert_eq!(params["userAgentMetadata"]["platform"], "Windows");
        assert!(parse_runtime_version("155.0.4283.45").is_some());
        assert!(parse_runtime_version("99.0.0.0").is_none());
        assert!(parse_runtime_version("not-a-version").is_none());
    }

    #[test]
    fn google_sign_in_script_uses_the_site_profile() {
        let browser = PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        let dir = PathBuf::from(r"C:\Users\haris\.omniworkspace\webapps\browser\webapp_chatgpt-p2\EBWebView");
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fchatgpt.com%2F";
        let script = browser_launch_script(&browser, &dir, url).unwrap();
        assert!(script.contains(r"C:\Program Files\Google\Chrome\Application\chrome.exe"));
        assert!(script.contains(r#"--user-data-dir=""C:\Users\haris\.omniworkspace\webapps\browser\webapp_chatgpt-p2\EBWebView""#));
        assert!(script.contains("client_id=x&redirect_uri="));
        assert!(script.contains("--no-first-run"));
        assert!(script.contains("--new-window"));
        assert!(script.contains("Wscript.Shell"));
        assert!(!script.to_ascii_lowercase().contains("user data"));
        assert!(browser_launch_script(&browser, &dir, "https://accounts.google.com/a\"b").is_err());
        assert!(browser_launch_script(&browser, &dir, "https://accounts.google.com/a^b").is_err());
        assert!(browser_launch_script(&browser, &dir, "https://accounts.google.com/a\nb").is_err());
        assert!(browser_launch_script(&browser, &PathBuf::from(r"C:\Users\haris\AppData\Local\Google\Chrome\User Data"), url).is_err());
        assert!(browser_launch_script(&browser, &dir, "https://chatgpt.com/").is_err());
        assert!(browser_launch_script(&browser, &dir, "https://auth.openai.com/authorize").is_err());
    }

    #[test]
    fn installed_browser_checks_chrome_before_edge() {
        let found = browser_candidates();
        assert!(found.len() >= 4);
        assert_eq!(found[0].1, "Chrome");
        assert!(found[0].0.ends_with("chrome.exe"));
        let edge = found.iter().position(|(_, name)| *name == "Edge").unwrap();
        assert!(found[..edge].iter().all(|(_, name)| *name == "Chrome"));
        assert!(found[edge].0.ends_with("msedge.exe"));
        assert!(found.iter().any(|(path, name)| *name == "Chrome" && path.ends_with("chrome.exe")));
    }
}
