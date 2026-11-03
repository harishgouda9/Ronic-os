use crate::error::{err, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::collections::VecDeque;
use tauri::Emitter;

static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn nid(prefix: &str) -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut salt = [0u8; 4];
    let _ = getrandom::getrandom(&mut salt);
    format!(
        "{prefix}_{:x}{:04x}{:02x}{:02x}{:02x}{:02x}",
        now_ms() as u64,
        n,
        salt[0],
        salt[1],
        salt[2],
        salt[3]
    )
}

/// Byte limit that never panics on a multibyte UTF-8 boundary.
pub fn prefix_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub fn truncate_utf8(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
}

/// Join `relative` onto `root` only when the result stays inside `root`.
pub fn confined_join(root: &Path, relative: &str) -> Result<PathBuf> {
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err(err("No project folder is set."));
    }
    let path = relative.trim();
    if path.is_empty() {
        return Err(err("path is empty"));
    }
    let as_path = Path::new(path);
    if as_path.is_absolute()
        || path.contains("..")
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.chars().nth(1) == Some(':')
        || path.split(['/', '\\']).any(blocked_path_part)
    {
        return Err(err("refusing to write outside the project root"));
    }
    let target = root.join(path);
    if !target.starts_with(root) {
        return Err(err("refusing to write outside the project root"));
    }
    Ok(target)
}

fn blocked_path_part(part: &str) -> bool {
    let lower = part.to_ascii_lowercase();
    lower == ".git"
        || lower == ".env"
        || lower.starts_with(".env.")
        || lower == "node_modules"
        || lower == "secrets.json"
        || lower == "secrets.vault"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

/// Parsed https URL, or http/ws on loopback. Rejects host-confusion prefixes.
pub fn https_or_loopback(raw: &str) -> Result<url::Url> {
    let parsed: url::Url = raw.trim().parse().map_err(|e: url::ParseError| err(e.to_string()))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(err("that URL is not allowed"));
    }
    let host = parsed.host_str().unwrap_or("");
    let loopback = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]";
    let ok = match parsed.scheme() {
        "https" | "wss" => !host.is_empty(),
        "http" | "ws" => loopback,
        _ => false,
    };
    if !ok {
        return Err(err("provider windows only open https, or localhost"));
    }
    Ok(parsed)
}

/// File-name fragment used when joining onto a workspace directory.
pub fn safe_id_component(id: &str) -> Result<&str> {
    let id = id.trim();
    if id.is_empty() || id.len() > 96 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(err("invalid id"));
    }
    Ok(id)
}

pub fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Resolve a user's standard documents/downloads folder without depending on
/// Windows environment variables. Linux desktop environments may move these
/// folders through `user-dirs.dirs`; macOS and Windows use the conventional
/// folders when no override is available.
pub fn user_folder(kind: &str) -> PathBuf {
    if let Some(configured) = xdg_user_folder(kind) {
        return configured;
    }
    user_home().join(match kind {
        "DOCUMENTS" => "Documents",
        "DOWNLOAD" => "Downloads",
        _ => kind,
    })
}

pub fn documents_dir() -> PathBuf {
    user_folder("DOCUMENTS")
}

pub fn downloads_dir() -> PathBuf {
    user_folder("DOWNLOAD")
}

fn xdg_user_folder(kind: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let path = user_home().join(".config").join("user-dirs.dirs");
    let key = format!("XDG_{kind}_DIR=");
    let contents = std::fs::read_to_string(path).ok()?;
    let line = contents
        .lines()
        .find(|line| line.trim_start().starts_with(&key))?;
    let raw = line.trim_start().strip_prefix(&key)?.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw.replace("$HOME", &user_home().to_string_lossy())))
}

pub fn product_home() -> PathBuf {
    let home = user_home().join(".ronicos");
    migrate_legacy_product_home(&home);
    home
}

/// One-time migration from the pre-rename data directory (`~/.omniworkspace`).
/// If the new home has no state.db but the legacy directory does, move the
/// legacy directory into place so existing users keep bots, threads, wallet
/// state, and the vault across the rename.
fn migrate_legacy_product_home(new_home: &Path) {
    let legacy = user_home().join(".omniworkspace");
    if new_home.join("state.db").exists() || !legacy.join("state.db").exists() {
        return;
    }
    if new_home.exists() {
        // New dir exists but has no database (partial init): merge by moving
        // only missing entries instead of replacing the whole directory.
        if let Ok(entries) = std::fs::read_dir(&legacy) {
            for entry in entries.flatten() {
                let dest = new_home.join(entry.file_name());
                if !dest.exists() {
                    let _ = std::fs::rename(entry.path(), &dest);
                }
            }
        }
    } else if std::fs::rename(&legacy, new_home).is_ok() {
        return;
    }
}

pub fn ipc_push(ipc: &Mutex<VecDeque<String>>, line: &str) {
    let mut guard = ipc.lock().unwrap_or_else(|e| e.into_inner());
    guard.push_back(format!("{} {line}", now_ms()));
    while guard.len() > 80 {
        guard.pop_front();
    }
}

pub fn run_capture(program: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<(i32, String)> {
    // Pipes must be drained while the child runs: a child that writes more
    // than the OS pipe buffer (~64 KB) blocks on a full pipe and never exits.
    // run_capture_stream keeps reader threads alive for the child's lifetime.
    run_capture_stream(program, args, cwd, timeout, |_| {})
}

pub fn split_args(cmd: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;

    for ch in cmd.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' && !in_single {
            escape = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch.is_whitespace() && !in_single && !in_double {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// True when an allowlisted interpreter is asked to eval a string instead of a file.
pub fn interpreter_eval_flag(program: &str, args: &[String]) -> Option<&'static str> {
    let file = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    let stem = file
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat")
        .to_ascii_lowercase();
    let blocked = match stem.as_str() {
        "python" | "python3" | "pythonw" | "pypy" | "pypy3" => flag_present(args, &["-c", "--command"]),
        "node" | "nodejs" => flag_present(args, &["-e", "--eval", "-p", "--print"]),
        "bun" => flag_present(args, &["-e", "--eval", "-p", "--print"]),
        "deno" => args.iter().any(|arg| arg == "eval") || flag_present(args, &["-e", "--eval"]),
        "npx" | "pnpx" => flag_present(args, &["-c", "--call", "-e", "--eval"]),
        _ => false,
    };
    if blocked {
        Some("inline interpreter eval is blocked in the sandbox")
    } else {
        None
    }
}

fn flag_present(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|arg| {
        flags.iter().any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
    })
}

pub fn broadcast_to_terminal(app: &tauri::AppHandle, text: &str) {
    if text.is_empty() {
        return;
    }
    let mut normalized = String::with_capacity(text.len() + 16);
    let mut prev = '\0';
    for ch in text.chars() {
        if ch == '\n' && prev != '\r' {
            normalized.push('\r');
        }
        normalized.push(ch);
        prev = ch;
    }
    let bytes = normalized.into_bytes();

    use tauri::Manager;
    let registered_sids = if let Some(mgr) = app.try_state::<crate::terminal_pty::TerminalManager>() {
        mgr.get_session_ids()
    } else {
        Vec::new()
    };

    if registered_sids.is_empty() {
        for sid in &["ronic_global", "coding_workspace", "workspace_main", "chat_workspace"] {
            let _ = app.emit(&format!("pty-output-{sid}"), &bytes);
        }
    } else {
        for sid in &registered_sids {
            let _ = app.emit(&format!("pty-output-{sid}"), &bytes);
        }
        for sid in &["ronic_global", "coding_workspace", "workspace_main", "chat_workspace"] {
            if !registered_sids.contains(&sid.to_string()) {
                let _ = app.emit(&format!("pty-output-{sid}"), &bytes);
            }
        }
    }
    let _ = app.emit("agent-terminal-active", ());
}

fn script_command(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let lower = program.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/d").arg("/v:off").arg("/c").arg(program);
            cmd.args(args);
            return cmd;
        }
    }
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd
}

pub fn run_capture_stream<F>(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    mut on_chunk: F,
) -> Result<(i32, String)>
where
    F: FnMut(&str),
{
    // CreateProcess cannot start a .cmd or .bat. cmd.exe can, and /v:off keeps
    // delayed expansion from rewriting the arguments.
    let mut cmd = script_command(program, args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| err(format!("could not start {program}: {e}")))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<String>();

    if let Some(mut stream) = stdout {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let s = String::from_utf8_lossy(&buf[..n]).to_string();
                if tx.send(s).is_err() {
                    break;
                }
            }
        });
    }

    if let Some(mut stream) = stderr {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let s = String::from_utf8_lossy(&buf[..n]).to_string();
                if tx.send(s).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let started = Instant::now();
    let mut total_output = String::new();

    loop {
        while let Ok(chunk) = rx.try_recv() {
            on_chunk(&chunk);
            if total_output.len() < 64_000 {
                total_output.push_str(&chunk);
            }
        }

        if let Some(status) = child.try_wait().map_err(|e| err(e.to_string()))? {
            while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(60)) {
                on_chunk(&chunk);
                if total_output.len() < 64_000 {
                    total_output.push_str(&chunk);
                }
            }
            if total_output.len() > 16_000 {
                truncate_utf8(&mut total_output, 16_000);
                total_output.push_str("\n…truncated");
            }
            return Ok((status.code().unwrap_or(-1), total_output));
        }

        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err(format!("{program} exceeded {}s", timeout.as_secs())));
        }

        std::thread::sleep(Duration::from_millis(25));
    }
}

static WHICH_SKIP_UNTIL: AtomicU64 = AtomicU64::new(0);

pub fn which(name: &str) -> Option<String> {
    let now = now_ms().max(0) as u64;
    if now < WHICH_SKIP_UNTIL.load(Ordering::Relaxed) {
        return None;
    }
    let finder = if cfg!(windows) { "where.exe" } else { "which" };
    match run_capture(finder, &[name], None, Duration::from_secs(3)) {
        Ok((code, output)) => {
            if code != 0 {
                return None;
            }
            let first = output.lines().map(str::trim).find(|line| !line.is_empty())?;
            if Path::new(first).exists() { Some(first.to_string()) } else { None }
        }
        Err(error) => {
            if error.0.contains("exceeded") {
                WHICH_SKIP_UNTIL.store(now.saturating_add(60_000), Ordering::Relaxed);
            }
            None
        }
    }
}

/// Rewrites the dead Grok host. Empty values fall back to ChatGPT's web session.
pub fn normalize_harness_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return "https://chatgpt.com".to_string();
    }
    if trimmed.contains("grok.x.ai") {
        return "https://grok.com".to_string();
    }
    trimmed.to_string()
}

pub fn windows_bin_candidates(file_stem: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let push = |paths: &mut Vec<PathBuf>, base: Option<std::ffi::OsString>, parts: &[&str]| {
        let Some(base) = base else { return };
        let mut path = PathBuf::from(base);
        for part in parts {
            path.push(part);
        }
        paths.push(path);
    };
    let appdata = std::env::var_os("APPDATA");
    let profile = std::env::var_os("USERPROFILE");
    let local = std::env::var_os("LOCALAPPDATA");
    for name in [format!("{file_stem}.cmd"), format!("{file_stem}.exe"), file_stem.to_string()] {
        push(&mut paths, appdata.clone(), &["npm", &name]);
        push(&mut paths, profile.clone(), &[".local", "bin", &name]);
        push(&mut paths, profile.clone(), &[".cargo", "bin", &name]);
        push(&mut paths, profile.clone(), &[".gemini", "bin", &name]);
        push(&mut paths, profile.clone(), &[".grok", "bin", &name]);
        push(&mut paths, local.clone(), &["hermes", "bin", &name]);
        push(&mut paths, local.clone(), &["Programs", file_stem, &name]);
    }
    paths
}

pub fn wsl_ready() -> bool {
    #[cfg(windows)]
    {
        run_capture("reg", &["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss"], None, Duration::from_secs(3))
            .map(|(code, _)| code == 0)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// One WSL boot for every still-missing CLI name. Returns unix name → absolute path.
pub fn wsl_which(names: &[&str]) -> Vec<(String, String)> {
    if names.is_empty() || !wsl_ready() {
        return Vec::new();
    }
    if names.iter().any(|name| !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return Vec::new();
    }
    let script = format!(
        "for b in {}; do p=$(command -v \"$b\" 2>/dev/null || true); if [ -n \"$p\" ]; then printf '%s\\t%s\\n' \"$b\" \"$p\"; fi; done",
        names.join(" ")
    );
    let Ok((code, output)) = run_capture("wsl.exe", &["-e", "sh", "-lc", &script], None, Duration::from_secs(12)) else {
        return Vec::new();
    };
    if code != 0 && output.trim().is_empty() {
        return Vec::new();
    }
    output
        .lines()
        .filter_map(|line| {
            let (name, path) = line.split_once('\t')?;
            let path = path.trim();
            if name.is_empty() || !path.starts_with('/') {
                None
            } else {
                Some((name.trim().to_string(), path.to_string()))
            }
        })
        .collect()
}

#[cfg(test)]
mod harness_url {
    use super::{confined_join, interpreter_eval_flag, normalize_harness_url, prefix_utf8, safe_id_component, shadow_name, shadow_target, truncate_utf8};

    #[test]
    fn shadow_name_and_target_roundtrip_and_reject_unencoded() {
        let name = shadow_name("extensions/skills/scraper.js", 1_700_000_000);
        assert_eq!(shadow_target(&name).as_deref(), Some("extensions/skills/scraper.js"));
        // Backslashes are normalised before encoding.
        let name2 = shadow_name("extensions\\skills\\a.json", 5);
        assert_eq!(shadow_target(&name2).as_deref(), Some("extensions/skills/a.json"));
        // Older, unencoded backups (json-heal.checkpoint_x.bak) carry no target.
        assert_eq!(shadow_target("json-heal.checkpoint_1a2b3c.bak"), None);
        assert_eq!(shadow_target("notabackup.txt"), None);
        // An encoded `..` can never escape the workspace: confined_join rejects it.
        let root = std::env::temp_dir();
        assert!(confined_join(&root, "extensions/../evil").is_err());
        assert!(confined_join(&root, "extensions/skills/a.json").is_ok());
    }

    #[test]
    fn dead_grok_host_becomes_grok_com() {
        assert_eq!(normalize_harness_url("https://grok.x.ai"), "https://grok.com");
        assert_eq!(normalize_harness_url("https://grok.x.ai/chat"), "https://grok.com");
        assert_eq!(normalize_harness_url(""), "https://chatgpt.com");
        assert_eq!(normalize_harness_url("https://grok.com"), "https://grok.com");
        assert_eq!(normalize_harness_url("https://chatgpt.com"), "https://chatgpt.com");
    }

    #[test]
    fn utf8_prefix_does_not_split_a_character() {
        let text = "éééé";
        assert!(text.len() > 5);
        let sliced = prefix_utf8(text, 5);
        assert!(sliced.is_char_boundary(sliced.len()));
        assert!(!sliced.is_empty());
        let mut owned = "😀😀😀".to_string();
        truncate_utf8(&mut owned, 5);
        assert!(owned.is_char_boundary(owned.len()));
    }

    #[test]
    fn confined_join_rejects_escape_and_empty_root() {
        let root = std::env::temp_dir();
        assert!(confined_join(&root, "../secret").is_err());
        assert!(confined_join(&root, "..\\secret").is_err());
        assert!(confined_join(&root, "/etc/passwd").is_err());
        assert!(confined_join(std::path::Path::new(""), "foo.txt").is_err());
        assert!(confined_join(&root, "src/main.rs").is_ok());
        assert!(safe_id_component("wf_ab12").is_ok());
        assert!(safe_id_component("../wf").is_err());
        assert!(safe_id_component("").is_err());
    }

    #[test]
    fn https_or_loopback_rejects_host_confusion() {
        use super::https_or_loopback;
        assert!(https_or_loopback("https://grok.com").is_ok());
        assert!(https_or_loopback("http://127.0.0.1:3000/app").is_ok());
        assert!(https_or_loopback("http://127.0.0.1.attacker.tld/").is_err());
        assert!(https_or_loopback("http://localhost.attacker.tld/").is_err());
        assert!(https_or_loopback("http://127.0.0.1@evil.example/").is_err());
    }

    #[test]
    fn interpreter_eval_flags_are_blocked() {
        assert!(interpreter_eval_flag("python", &["-c".into(), "print(1)".into()]).is_some());
        assert!(interpreter_eval_flag("node.exe", &["-e".into(), "1".into()]).is_some());
        assert!(interpreter_eval_flag("bun", &["--eval=1".into()]).is_some());
        assert!(interpreter_eval_flag("deno", &["eval".into(), "1".into()]).is_some());
        assert!(interpreter_eval_flag("python", &["script.py".into()]).is_none());
        assert!(interpreter_eval_flag("git", &["status".into()]).is_none());
    }
}

pub fn exists_file(path: &str) -> bool {
    !path.is_empty() && Path::new(path).is_file()
}

/// Encode a workspace-relative path as a `.shadow-git` backup name. `/` and
/// `\` become `__`, so `extensions/skills/scraper.js` becomes
/// `extensions__skills__scraper.js.<stamp>.bak`. The restore parses the same
/// encoding, so a backup always maps back to exactly one in-workspace target.
pub fn shadow_name(rel_path: &str, stamp: i64) -> String {
    let encoded = rel_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("__");
    format!("{encoded}.{stamp}.bak")
}

/// Inverse of [`shadow_name`]: recover the workspace-relative target path from
/// a backup name. Returns `None` for names that do not carry the encoded path
/// (older, unencoded backups stay listed but cannot be auto-restored).
pub fn shadow_target(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".bak")?;
    let (encoded, stamp) = stem.rsplit_once('.')?;
    if stamp.is_empty() || !stamp.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if encoded.is_empty() {
        return None;
    }
    Some(encoded.split("__").collect::<Vec<_>>().join("/"))
}

pub fn read_to_string_limited(path: &Path, max: usize) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = String::new();
    file.take(max as u64).read_to_string(&mut buf).ok()?;
    Some(buf)
}
