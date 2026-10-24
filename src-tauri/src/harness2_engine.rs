//! Local coordinator for google-research/harness2.
//!
//! MCP and the chat model stay in place. This module scores a prompt, records
//! a plan, and can install or run the upstream deterministic demo. It does not
//! start OpenCode, Codex, or Claude, and it does not edit the base soul until
//! Promote is clicked.

use crate::db;
use crate::error::OmniError;
use crate::memory::{remember, MemoryInput};
use crate::util::{nid, now_ms, run_capture, truncate_utf8};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::State;

use crate::AppState;

const FLAGS_KEY: &str = "harness2_flags";
const CHECK_KEY: &str = "harness2_last_check";
const COMPONENTS: [&str; 8] = [
    "system_prompt",
    "guardrails",
    "memory",
    "tool_guidance",
    "subagents",
    "skills",
    "scripts",
    "plugins",
];
const KEYWORDS: [&str; 9] = [
    "reverse engineer",
    "security audit",
    "end-to-end",
    "architect",
    "migrate",
    "refactor",
    "backtest",
    "optimize",
    "concurrency",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Flags {
    mode: String,
    recursion: String,
    budget_k: u8,
    threshold: u8,
    escalate: bool,
    editor_label: String,
    substrate: String,
    components: Vec<String>,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            recursion: "parallel".into(),
            budget_k: 1,
            threshold: 65,
            escalate: true,
            editor_label: "Local plan only".into(),
            substrate: "opencode".into(),
            components: COMPONENTS.iter().map(|item| (*item).to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Complexity {
    value: u8,
    reasons: Vec<String>,
    armed: bool,
    threshold: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCard {
    run_id: String,
    bot_id: String,
    trigger: String,
    score: i64,
    reasons: Vec<String>,
    recursion: String,
    budget_k: i64,
    editor: String,
    executor: String,
    components: Vec<String>,
    probes_executed: bool,
    probe_note: String,
    proposal: String,
    adopted: bool,
    promoted: bool,
    soul_untouched: bool,
    backup_path: String,
    log: String,
    output_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    flags: Flags,
    uv_path: String,
    repo_dir: String,
    repo_present: bool,
    venv_present: bool,
    demo_present: bool,
    version: String,
    note: String,
    last_check: String,
    run_count: i64,
    library_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    ok: bool,
    already: bool,
    uv_path: String,
    log: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    id: String,
    bot_id: String,
    domain_tag: String,
    component_type: String,
    title: String,
    when_to_apply_rule: String,
    behavioral_evidence: String,
    artifact_path_or_content: String,
    source_run_id: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagPatch {
    mode: Option<String>,
    recursion: Option<String>,
    budget_k: Option<u8>,
    threshold: Option<u8>,
    escalate: Option<bool>,
    editor_label: Option<String>,
    substrate: Option<String>,
    components: Option<Vec<String>>,
}

pub fn arm_chat(conn: &Connection, home: &Path, prompt: &str, attachments: &[String]) {
    if let Err(error) = arm_inner(conn, home, prompt, attachments) {
        let thread = db::kv_get(conn, "active_thread").ok().flatten().unwrap_or_default();
        if !thread.is_empty() {
            let _ = db::insert_step(conn, &thread, "tool", "harness2", &error, "message", &json!({}), 0);
        }
    }
}

pub fn note_mid_run(conn: &Connection, home: &Path, thread_id: &str, turn_id: &str) {
    let _ = note_mid_run_inner(conn, home, thread_id, turn_id);
}

fn arm_inner(conn: &Connection, home: &Path, prompt: &str, attachments: &[String]) -> Result<(), String> {
    let flags = load_flags(conn);
    let covered = skill_covered(conn, prompt);
    let squad = prompt.to_ascii_lowercase().contains("#squad") || prompt.to_ascii_lowercase().contains("squad");
    let mut score = score_prompt(prompt, attachments.len(), squad, covered);
    score.threshold = flags.threshold;
    let armed = flags.mode == "force" || (flags.mode == "auto" && score.value >= flags.threshold);
    if !armed {
        return Ok(());
    }
    let thread_id = db::kv_get(conn, "active_thread").map_err(|e| e.to_string())?.unwrap_or_default();
    let turn_id = latest_turn(conn, &thread_id);
    let bot_id = db::kv_get(conn, "active_profile").map_err(|e| e.to_string())?.unwrap_or_default();
    if thread_id.is_empty() || bot_id.is_empty() {
        return Ok(());
    }
    let started = Instant::now();
    let trigger = if flags.mode == "force" { "manual_force_on" } else { "auto_pre_flight" };
    let card = plan_run(conn, home, &bot_id, &thread_id, &turn_id, prompt, trigger, &flags, &score, started.elapsed().as_millis() as i64)?;
    let _ = card;
    Ok(())
}

fn note_mid_run_inner(conn: &Connection, home: &Path, thread_id: &str, turn_id: &str) -> Result<(), String> {
    let flags = load_flags(conn);
    if !flags.escalate || flags.mode == "off" {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT action_payload_json FROM execution_steps WHERE thread_id=?1 AND turn_id=?2 AND action_type='pty_terminal'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![thread_id, turn_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut failed: Vec<String> = Vec::new();
    for row in rows {
        let raw = row.map_err(|e| e.to_string())?;
        let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
        let code = payload.get("exitCode").and_then(|value| value.as_i64()).unwrap_or(0);
        if code != 0 {
            let command = payload.get("command").and_then(|value| value.as_str()).unwrap_or("command");
            failed.push(format!("{command} exited {code}"));
        }
    }
    if failed.is_empty() {
        return Ok(());
    }
    let existing: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM execution_steps WHERE thread_id=?1 AND turn_id=?2 AND action_type='harness2_pipeline' AND action_payload_json LIKE '%auto_mid_run_error%'",
            params![thread_id, turn_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if existing > 0 {
        return Ok(());
    }
    let bot_id = db::kv_get(conn, "active_profile").ok().flatten().unwrap_or_default();
    if bot_id.is_empty() {
        return Ok(());
    }
    let note = format!(
        "A terminal command failed ({}). Supercharge did not start a second model, OpenCode, Codex, or a probe process.",
        failed.join("; ")
    );
    let score = Complexity { value: 0, reasons: failed.clone(), armed: true, threshold: flags.threshold };
    let mut flags = flags;
    flags.editor_label = "Local plan only".into();
    plan_run(conn, home, &bot_id, thread_id, turn_id, &note, "auto_mid_run_error", &flags, &score, 0)?;
    Ok(())
}

fn plan_run(
    conn: &Connection,
    home: &Path,
    bot_id: &str,
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    trigger: &str,
    flags: &Flags,
    score: &Complexity,
    duration_ms: i64,
) -> Result<RunCard, String> {
    let run_id = nid("h2");
    let domain = domain_of(prompt);
    let components = flags.components.clone();
    let sandbox = home.join("sandbox").join("h2_runs").join(&run_id);
    let base = sandbox.join("base_ref");
    let probe = sandbox.join("probe_0");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    fs::create_dir_all(&probe).map_err(|e| e.to_string())?;
    let proposal = proposal_text(prompt, score, flags, &components, &sandbox);
    fs::write(base.join("README.md"), &proposal).map_err(|e| e.to_string())?;
    fs::write(probe.join("PROPOSAL.md"), &proposal).map_err(|e| e.to_string())?;
    if flags.recursion == "parallel" && flags.budget_k > 1 {
        let extra = sandbox.join("probe_1");
        fs::create_dir_all(&extra).map_err(|e| e.to_string())?;
        fs::write(extra.join("PROPOSAL.md"), &proposal).map_err(|e| e.to_string())?;
    }
    let probe_note = "Contrastive probes were not executed. The sandbox holds the plan only. The live project was not copied and no git worktree was created.";
    let lesson = format!("{proposal}\n\n{probe_note}");
    let contrasts = json!({
        "probesExecuted": false,
        "reason": probe_note,
        "sandbox": sandbox.display().to_string(),
        "reasons": score.reasons,
    });
    conn.execute(
        "INSERT INTO harness2_runs (id, bot_id, domain_tag, trigger_mode, recursion_mode, substrate, budget_k, complexity_score, editor_model, executor_model, modified_components_json, probe_contrasts_json, composed_diff_patch, experience_lesson_md, adopted_into_library, promoted_to_base_profile, shadow_git_commit, duration_ms, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,0,'',?15,?16)",
        params![
            run_id,
            bot_id,
            domain,
            trigger,
            flags.recursion,
            flags.substrate,
            flags.budget_k as i64,
            score.value as i64,
            flags.editor_label,
            "not started",
            serde_json::to_string(&components).unwrap_or_else(|_| "[]".into()),
            contrasts.to_string(),
            proposal,
            lesson,
            duration_ms,
            now_ms(),
        ],
    )
    .map_err(|e| e.to_string())?;
    let card = RunCard {
        run_id: run_id.clone(),
        bot_id: bot_id.to_string(),
        trigger: trigger.to_string(),
        score: score.value as i64,
        reasons: score.reasons.clone(),
        recursion: flags.recursion.clone(),
        budget_k: flags.budget_k as i64,
        editor: flags.editor_label.clone(),
        executor: "not started".into(),
        components,
        probes_executed: false,
        probe_note: probe_note.into(),
        proposal: proposal.clone(),
        adopted: false,
        promoted: false,
        soul_untouched: true,
        backup_path: String::new(),
        log: String::new(),
        output_files: Vec::new(),
    };
    let summary = if trigger == "auto_mid_run_error" {
        format!("A command failed. Probes were not started. {}", clip(prompt, 180))
    } else {
        format!("Supercharge plan only. Score {}/{}. Probes were not started.", score.value, flags.threshold)
    };
    db::insert_step_in(conn, thread_id, turn_id, "tool", "harness2", &summary, "harness2_pipeline", &serde_json::to_value(&card).unwrap_or(json!({})), duration_ms)
        .map_err(|e| e.to_string())?;
    Ok(card)
}

fn proposal_text(prompt: &str, score: &Complexity, flags: &Flags, components: &[String], sandbox: &Path) -> String {
    let clipped = clip(prompt, 500);
    let reasons = if score.reasons.is_empty() { "none".to_string() } else { score.reasons.join("; ") };
    format!(
        "Harness² plan. This file is not an executed edit.\n\nTask:\n{clipped}\n\nLocal score: {value}/100 (threshold {threshold}). Reasons: {reasons}.\nMode: {mode}. Recursion setting: {recursion}. Budget k: {k}. Substrate label: {substrate} (process not started).\nEditor: {editor} (not called).\n\nComponents in scope:\n{components}\n\nSoft guardrails may be drafted later under this sandbox. Wallet caps, the fail-closed gateway, and OS keychain access are not editable here.\nSandbox: {sandbox}\nThe base soul was not modified.",
        value = score.value,
        threshold = score.threshold,
        mode = flags.mode,
        recursion = flags.recursion,
        k = flags.budget_k,
        substrate = flags.substrate,
        editor = flags.editor_label,
        components = components.join("\n"),
        sandbox = sandbox.display(),
    )
}

pub fn score_prompt(prompt: &str, attachment_count: usize, squad: bool, skill_covered: bool) -> Complexity {
    let mut value: i32 = 0;
    let mut reasons = Vec::new();
    let lower = prompt.to_ascii_lowercase();
    let mut hits = 0u8;
    for keyword in KEYWORDS {
        if lower.contains(keyword) {
            let weight = match hits {
                0 => 40,
                1 => 25,
                _ => 15,
            };
            if hits < 3 {
                value += weight;
                reasons.push(format!("keyword \"{keyword}\" (+{weight})"));
                hits += 1;
            }
        }
    }
    if prompt.chars().count() > 180 {
        value += 15;
        reasons.push("prompt longer than 180 characters (+15)".into());
    }
    if attachment_count >= 2 {
        value += 15;
        reasons.push(format!("{attachment_count} attachments (+15)"));
    }
    if squad {
        value += 20;
        reasons.push("squad target (+20)".into());
    }
    if !skill_covered {
        value += 12;
        reasons.push("no skill slug from this workspace matched the prompt (+12)".into());
    }
    let value = value.clamp(0, 100) as u8;
    Complexity { value, reasons, armed: false, threshold: 65 }
}

fn skill_covered(conn: &Connection, prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    let Ok(mut stmt) = conn.prepare("SELECT slug, slash_command FROM skills") else { return false };
    let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else { return false };
    for row in rows.flatten() {
        for token in [row.0, row.1.trim_start_matches('/').to_string()] {
            let token = token.to_ascii_lowercase();
            if token.len() >= 4 && lower.contains(&token) {
                return true;
            }
        }
    }
    false
}

fn domain_of(prompt: &str) -> &'static str {
    let lower = prompt.to_ascii_lowercase();
    if lower.contains("rust") || lower.contains("cargo") {
        "rust"
    } else if lower.contains("react") || lower.contains("typescript") {
        "ui"
    } else {
        "general"
    }
}

fn latest_turn(conn: &Connection, thread_id: &str) -> String {
    conn.query_row(
        "SELECT turn_id FROM execution_steps WHERE thread_id=?1 AND role='user' ORDER BY created_at DESC LIMIT 1",
        params![thread_id],
        |row| row.get(0),
    )
    .unwrap_or_default()
}

fn load_flags(conn: &Connection) -> Flags {
    let Ok(Some(raw)) = db::kv_get(conn, FLAGS_KEY) else { return Flags::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_flags(conn: &Connection, flags: &Flags) -> Result<(), OmniError> {
    db::kv_set(conn, FLAGS_KEY, &serde_json::to_string(flags)?)
}

fn apply_patch(flags: &mut Flags, patch: FlagPatch) -> Result<(), String> {
    if let Some(mode) = patch.mode {
        if mode != "off" && mode != "auto" && mode != "force" {
            return Err("mode must be off, auto, or force".into());
        }
        flags.mode = mode;
    }
    if let Some(recursion) = patch.recursion {
        if recursion != "parallel" && recursion != "sequential" {
            return Err("recursion must be parallel or sequential".into());
        }
        flags.recursion = recursion;
    }
    if let Some(k) = patch.budget_k {
        if k != 1 && k != 2 {
            return Err("budget k must be 1 or 2".into());
        }
        flags.budget_k = k;
    }
    if let Some(threshold) = patch.threshold {
        if threshold > 100 {
            return Err("threshold must be 0 to 100".into());
        }
        flags.threshold = threshold;
    }
    if let Some(escalate) = patch.escalate {
        flags.escalate = escalate;
    }
    if let Some(label) = patch.editor_label {
        let clean = label.replace(['\n', '\r'], " ");
        if clean.trim().is_empty() || clean.chars().count() > 80 {
            return Err("editor label must be 1 to 80 characters".into());
        }
        flags.editor_label = clean;
    }
    if let Some(substrate) = patch.substrate {
        if substrate != "opencode" && substrate != "codex_cx" && substrate != "claude_acp" {
            return Err("substrate must be opencode, codex_cx, or claude_acp".into());
        }
        flags.substrate = substrate;
    }
    if let Some(components) = patch.components {
        if components.is_empty() || components.iter().any(|item| !COMPONENTS.contains(&item.as_str())) {
            return Err("components must be a non-empty subset of the 8 harness fields".into());
        }
        flags.components = components;
    }
    Ok(())
}

fn repo_dir(home: &Path) -> PathBuf {
    home.join("engines").join("harness2")
}

fn tool_exe(repo: &Path, name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        repo.join(".venv").join("Scripts").join(format!("{name}.exe"))
    }
    #[cfg(not(windows))]
    {
        repo.join(".venv").join("bin").join(name)
    }
}

fn find_uv() -> Option<PathBuf> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("hermes").join("bin").join("uv.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    crate::util::which("uv.exe")
        .or_else(|| crate::util::which("uv"))
        .map(PathBuf::from)
}

fn version_of(repo: &Path) -> String {
    let Ok(text) = fs::read_to_string(repo.join("pyproject.toml")) else { return String::new() };
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("version") {
            let rest = rest.trim().trim_start_matches('=').trim().trim_matches('"').trim_matches('\'');
            if !rest.is_empty() && rest.len() < 40 {
                return rest.to_string();
            }
        }
    }
    String::new()
}

fn engine_note(uv: &Option<PathBuf>, repo_present: bool, demo_present: bool, version: &str) -> String {
    match (uv, repo_present, demo_present) {
        (None, _, _) => "uv.exe was not found in %LOCALAPPDATA%\\hermes\\bin or on PATH. WSL was not asked to install Python.".into(),
        (Some(path), false, _) => format!("uv is {path}. The harness2 checkout is not installed yet.", path = path.display()),
        (Some(_), true, false) => "The checkout is present and the demo command is not installed yet.".into(),
        (Some(_), true, true) => format!("harness2-demo is installed{}. The engine installs and verifies itself at launch; the demo button runs it again.", if version.is_empty() { String::new() } else { format!(" ({version})") }),
    }
}

fn status_of(conn: &Connection, home: &Path) -> HarnessStatus {
    let flags = load_flags(conn);
    let uv = find_uv();
    let repo = repo_dir(home);
    let repo_present = repo.join(".git").is_dir();
    let venv_present = repo.join(".venv").is_dir();
    let demo_present = tool_exe(&repo, "harness2-demo").is_file();
    let version = if repo_present { version_of(&repo) } else { String::new() };
    let last_check = db::kv_get(conn, CHECK_KEY).ok().flatten().unwrap_or_default();
    let run_count: i64 = conn.query_row("SELECT COUNT(*) FROM harness2_runs", [], |row| row.get(0)).unwrap_or(0);
    let library_count: i64 = conn.query_row("SELECT COUNT(*) FROM harness2_library_entries", [], |row| row.get(0)).unwrap_or(0);
    HarnessStatus {
        note: engine_note(&uv, repo_present, demo_present, &version),
        uv_path: uv.map(|path| path.display().to_string()).unwrap_or_default(),
        repo_dir: repo.display().to_string(),
        repo_present,
        venv_present,
        demo_present,
        version,
        last_check,
        run_count,
        library_count,
        flags,
    }
}

fn install_engine(home: &Path) -> InstallReport {
    let Some(uv) = find_uv() else {
        return InstallReport {
            ok: false,
            already: false,
            uv_path: String::new(),
            log: "uv.exe was not found in %LOCALAPPDATA%\\hermes\\bin or on PATH. Nothing was cloned.".into(),
        };
    };
    let repo = repo_dir(home);
    let demo = tool_exe(&repo, "harness2-demo");
    if repo.join(".git").is_dir() && demo.is_file() {
        return InstallReport {
            ok: true,
            already: true,
            uv_path: uv.display().to_string(),
            log: format!("Already installed at {}. harness2-demo is present. Nothing was reinstalled.", repo.display()),
        };
    }
    let mut log = String::new();
    if !repo.join(".git").is_dir() {
        if repo.exists() {
            return InstallReport {
                ok: false,
                already: false,
                uv_path: uv.display().to_string(),
                log: format!("{} exists and is not a git checkout. It was left untouched.", repo.display()),
            };
        }
        if let Some(parent) = repo.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                return InstallReport { ok: false, already: false, uv_path: uv.display().to_string(), log: error.to_string() };
            }
        }
        let Some(git) = crate::util::which("git").or_else(|| crate::util::which("git.exe")) else {
            return InstallReport { ok: false, already: false, uv_path: uv.display().to_string(), log: "git was not found on PATH. Nothing was cloned.".into() };
        };
        let dest = repo.display().to_string();
        match run_capture(&git, &["clone", "--depth", "1", "https://github.com/google-research/harness2.git", &dest], None, Duration::from_secs(180)) {
            Ok((code, output)) => {
                log.push_str(&format!("git clone exit {code}\n{output}\n"));
                if code != 0 {
                    return InstallReport { ok: false, already: false, uv_path: uv.display().to_string(), log };
                }
            }
            Err(error) => return InstallReport { ok: false, already: false, uv_path: uv.display().to_string(), log: error.0 },
        }
    }
    let uv_text = uv.display().to_string();
    match run_capture(&uv_text, &["venv", "--python", "3.12", ".venv"], Some(&repo), Duration::from_secs(180)) {
        Ok((code, output)) => {
            log.push_str(&format!("uv venv exit {code}\n{output}\n"));
            if code != 0 {
                return InstallReport { ok: false, already: false, uv_path: uv_text, log };
            }
        }
        Err(error) => return InstallReport { ok: false, already: false, uv_path: uv_text, log: format!("{log}{}", error.0) },
    }
    match run_capture(&uv_text, &["pip", "install", "-e", ".[render]"], Some(&repo), Duration::from_secs(480)) {
        Ok((code, output)) => {
            log.push_str(&format!("uv pip install exit {code}\n{output}\n"));
            if code != 0 {
                return InstallReport { ok: false, already: false, uv_path: uv_text, log };
            }
        }
        Err(error) => return InstallReport { ok: false, already: false, uv_path: uv_text, log: format!("{log}{}", error.0) },
    }
    let ok = tool_exe(&repo, "harness2-demo").is_file();
    if !ok {
        log.push_str("Install finished but harness2-demo was not found in the venv.");
    }
    InstallReport { ok, already: false, uv_path: uv_text, log }
}

const WINDOWS_FCNTL: &str = r#"LOCK_EX = 2
LOCK_SH = 1
LOCK_UN = 8
LOCK_NB = 4

def flock(_fileobj, _operation):
    return None
"#;

fn windows_shim(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join("engines").join("win-shim");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    fs::write(dir.join("fcntl.py"), WINDOWS_FCNTL).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn run_harness(program: &Path, args: &[&str], cwd: Option<&Path>, timeout: Duration, home: &Path) -> Result<(i32, String), String> {
    let shim = windows_shim(home)?;
    let mut pythonpath = shim.display().to_string();
    if let Ok(existing) = std::env::var("PYTHONPATH") {
        if !existing.trim().is_empty() {
            pythonpath.push(';');
            pythonpath.push_str(existing.trim());
        }
    }
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .env("PYTHONPATH", &pythonpath)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|error| format!("could not start {}: {error}", program.display()))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let mut out = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                use std::io::Read;
                stdout.read_to_string(&mut out).ok();
            }
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let mut err_buf = String::new();
                stderr.read_to_string(&mut err_buf).ok();
                if !err_buf.is_empty() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&err_buf);
                }
            }
            if out.len() > 16_000 {
                truncate_utf8(&mut out, 16_000);
                out.push_str("\n…truncated");
            }
            return Ok((status.code().unwrap_or(-1), out));
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{} exceeded {}s", program.display(), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn run_check(home: &Path) -> Result<String, String> {
    let repo = repo_dir(home);
    let exe = tool_exe(&repo, "harness2-check");
    if !exe.is_file() {
        return Err("harness2-check is not installed. The check was not run.".into());
    }
    // --bench is required by the upstream CLI. JobBench is the flagship
    // benchmark; its FAIL lines name whatever optional pieces (judge URL,
    // document toolchain) are still missing on this computer.
    let (code, output) = run_harness(&exe, &["--bench", "jb"], Some(&repo), Duration::from_secs(90), home)?;
    Ok(format!("exit {code}\n{output}"))
}

fn run_demo(home: &Path, bot_id: &str, k: u8) -> Result<(i32, String, Vec<String>, PathBuf), String> {
    let repo = repo_dir(home);
    let exe = tool_exe(&repo, "harness2-demo");
    if !exe.is_file() {
        return Err("harness2-demo is not installed. No demo trace was created.".into());
    }
    let output = home.join("bots").join(safe_id(bot_id)).join("harness2_runs").join(format!("demo-k{k}"));
    fs::create_dir_all(&output).map_err(|e| e.to_string())?;
    let k_text = k.to_string();
    let output_text = output.display().to_string();
    let (code, log) = run_harness(
        &exe,
        &["--output", &output_text, "--k", &k_text],
        Some(&repo),
        Duration::from_secs(180),
        home,
    )?;
    let files = list_files(&output, 30);
    Ok((code, log, files, output))
}

fn list_files(root: &Path, max: usize) -> Vec<String> {
    let mut names = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if names.len() >= max {
                return names;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(root) {
                names.push(rel.display().to_string());
            }
        }
    }
    names.sort();
    names
}

fn safe_id(id: &str) -> String {
    let clean: String = id.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' }).collect();
    if clean.is_empty() { "bot".into() } else { clean }
}

fn clip(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max) {
        out.push(ch);
    }
    if text.chars().count() > max {
        out.push_str("…");
    }
    out
}

fn row_card(conn: &Connection, run_id: &str) -> Result<RunCard, String> {
    let (bot_id, trigger, recursion, _substrate, budget_k, score, editor, executor, components_json, contrasts_json, proposal, lesson, adopted, promoted, backup): (
        String, String, String, String, i64, i64, String, String, String, String, String, String, i64, i64, String,
    ) = conn
        .query_row(
            "SELECT bot_id, trigger_mode, recursion_mode, substrate, budget_k, complexity_score, editor_model, executor_model, modified_components_json, probe_contrasts_json, composed_diff_patch, experience_lesson_md, adopted_into_library, promoted_to_base_profile, COALESCE(shadow_git_commit,'') FROM harness2_runs WHERE id=?1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?,
                ))
            },
        )
        .map_err(|_| "run not found".to_string())?;
    let contrasts: Value = serde_json::from_str(&contrasts_json).unwrap_or(json!({}));
    let components = serde_json::from_str(&components_json).unwrap_or_default();
    let reasons = contrasts.get("reasons").and_then(|value| value.as_array()).map(|rows| rows.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let files = contrasts.get("outputFiles").and_then(|value| value.as_array()).map(|rows| rows.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default();
    Ok(RunCard {
        run_id: run_id.to_string(),
        bot_id,
        trigger,
        score,
        reasons,
        recursion,
        budget_k,
        editor,
        executor,
        components,
        probes_executed: contrasts.get("probesExecuted").and_then(|value| value.as_bool()).unwrap_or(false),
        probe_note: contrasts.get("reason").and_then(|value| value.as_str()).unwrap_or("").to_string(),
        proposal,
        adopted: adopted != 0,
        promoted: promoted != 0,
        soul_untouched: promoted == 0,
        backup_path: backup,
        log: lesson,
        output_files: files,
    })
}

fn rewrite_step(conn: &Connection, card: &RunCard) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, action_payload_json FROM execution_steps WHERE action_type='harness2_pipeline' ORDER BY created_at DESC LIMIT 40")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, raw) = row.map_err(|e| e.to_string())?;
        let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
        if payload.get("runId").and_then(|value| value.as_str()) == Some(card.run_id.as_str()) {
            conn.execute(
                "UPDATE execution_steps SET action_payload_json=?1 WHERE id=?2",
                params![serde_json::to_string(card).map_err(|e| e.to_string())?, id],
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Ok(())
}

fn assert_soft(text: &str) -> Result<(), String> {
    let lower = text.to_ascii_lowercase();
    for blocked in ["max_per_tx", "daily_wallet_limit", "killswitch", "keychain"] {
        if lower.contains(blocked) {
            return Err(format!("this plan mentions {blocked}, so it was not written onto the base soul"));
        }
    }
    Ok(())
}

fn library_dir(home: &Path, bot_id: &str) -> PathBuf {
    home.join("bots").join(safe_id(bot_id)).join("library")
}

/// Startup verification: the deterministic local demo is the piece Ronic OS
/// actually ships and runs, and it finishes in seconds. harness2-check (the
/// button) measures benchmark readiness, which legitimately fails while
/// optional external pieces (judge URL, document toolchain) are absent —
/// wrong signal for "did the install work".
fn run_quick_demo(home: &Path) -> Result<String, String> {
    let repo = repo_dir(home);
    let exe = tool_exe(&repo, "harness2-demo");
    if !exe.is_file() {
        return Err("harness2-demo is not installed. The verification was not run.".into());
    }
    let (code, output) = run_harness(&exe, &["--k", "1"], Some(&repo), Duration::from_secs(120), home)?;
    let tail = output.lines().rev().find(|line| line.contains("tasks completed")).unwrap_or("");
    Ok(format!("demo exit {code}. {tail}"))
}

#[tauri::command]
pub async fn harness2_status(state: State<'_, AppState>) -> Result<HarnessStatus, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(status_of(&conn, &state.home))
}

/// Install and verify harness2 once per launch, in the background, so the
/// engine is ready before the user first opens the Harness2 studio. The
/// install is idempotent: an existing checkout only gets the verification
/// pass. uv or git missing is reported, not fatal — the Install button in the
/// studio remains the manual fallback.
pub fn ensure_installed(app: tauri::AppHandle) {
    use tauri::Manager;
    std::thread::spawn(move || {
        let home = crate::util::product_home();
        let Some(state) = app.try_state::<AppState>() else { return };
        let report = install_engine(&home);
        let note = |line: String| {
            crate::util::ipc_push(&state.ipc, &line);
        };
        if !report.ok {
            if !report.already {
                note(format!("harness2 auto-install did not complete: {}", report.log.lines().next().unwrap_or("unknown error")));
            }
            return;
        }
        match run_quick_demo(&home) {
            Ok(log) => {
                if let Ok(conn) = state.conn.lock() {
                    let _ = db::kv_set(&conn, CHECK_KEY, &log);
                }
                note(format!("harness2 is installed and verified by the local demo. {log}"));
            }
            Err(error) => {
                note(format!("harness2 installed but the verification demo failed: {error}"));
            }
        }
    });
}

#[tauri::command]
pub async fn harness2_set_flags(state: State<'_, AppState>, patch: FlagPatch) -> Result<HarnessStatus, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut flags = load_flags(&conn);
    apply_patch(&mut flags, patch)?;
    save_flags(&conn, &flags).map_err(|e| e.0)?;
    Ok(status_of(&conn, &state.home))
}

#[tauri::command]
pub async fn harness2_install(state: State<'_, AppState>) -> Result<InstallReport, String> {
    let home = state.home.clone();
    tauri::async_runtime::spawn_blocking(move || install_engine(&home))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn harness2_check(state: State<'_, AppState>) -> Result<String, String> {
    let home = state.home.clone();
    let log = tauri::async_runtime::spawn_blocking(move || run_check(&home))
        .await
        .map_err(|e| e.to_string())??;
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    db::kv_set(&conn, CHECK_KEY, &log).map_err(|e| e.to_string())?;
    Ok(log)
}

#[tauri::command]
pub async fn harness2_score(state: State<'_, AppState>, prompt: String, attachment_count: Option<u8>) -> Result<Complexity, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let flags = load_flags(&conn);
    let squad = prompt.to_ascii_lowercase().contains("#squad") || prompt.to_ascii_lowercase().contains("squad");
    let mut score = score_prompt(&prompt, attachment_count.unwrap_or(0) as usize, squad, skill_covered(&conn, &prompt));
    score.threshold = flags.threshold;
    score.armed = flags.mode == "force" || (flags.mode == "auto" && score.value >= flags.threshold);
    Ok(score)
}

#[tauri::command]
pub async fn harness2_demo(state: State<'_, AppState>, budget_k: Option<u8>) -> Result<RunCard, String> {
    let k = match budget_k.unwrap_or(2) {
        1 => 1,
        2 => 2,
        _ => return Err("budget k must be 1 or 2".into()),
    };
    let home = state.home.clone();
    let bot_id = {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        db::kv_get(&conn, "active_profile").ok().flatten().unwrap_or_else(|| "local".into())
    };
    let bot_for_run = bot_id.clone();
    let (code, log, files, output) = tauri::async_runtime::spawn_blocking(move || run_demo(&home, &bot_for_run, k))
        .await
        .map_err(|e| e.to_string())??;
    let probes = code == 0;
    let note = if probes {
        "harness2-demo exited 0. This is the upstream deterministic demo, not a probe of the open project."
    } else {
        "harness2-demo did not exit 0. No success trace was invented."
    };
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let flags = load_flags(&conn);
    let run_id = nid("h2");
    let contrasts = json!({
        "probesExecuted": probes,
        "reason": note,
        "outputFiles": files,
        "outputDir": output.display().to_string(),
        "exitCode": code,
    });
    let proposal = format!("{note}\n\nOutput: {}\n\n{log}", output.display());
    conn.execute(
        "INSERT INTO harness2_runs (id, bot_id, domain_tag, trigger_mode, recursion_mode, substrate, budget_k, complexity_score, editor_model, executor_model, modified_components_json, probe_contrasts_json, composed_diff_patch, experience_lesson_md, adopted_into_library, promoted_to_base_profile, shadow_git_commit, duration_ms, created_at) VALUES (?1,?2,'demo','local_demo',?3,?4,?5,0,?6,'harness2-demo','[]',?7,?8,?8,0,0,'',0,?9)",
        params![run_id, bot_id, flags.recursion, flags.substrate, k as i64, flags.editor_label, contrasts.to_string(), proposal, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    row_card(&conn, &run_id)
}

#[tauri::command]
pub async fn harness2_library(state: State<'_, AppState>, query: Option<String>) -> Result<Vec<LibraryEntry>, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let needle = query.unwrap_or_default().to_ascii_lowercase();
    let mut stmt = conn
        .prepare("SELECT id, bot_id, domain_tag, component_type, title, when_to_apply_rule, behavioral_evidence, artifact_path_or_content, COALESCE(source_run_id,''), created_at FROM harness2_library_entries ORDER BY created_at DESC LIMIT 80")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LibraryEntry {
                id: row.get(0)?,
                bot_id: row.get(1)?,
                domain_tag: row.get(2)?,
                component_type: row.get(3)?,
                title: row.get(4)?,
                when_to_apply_rule: row.get(5)?,
                behavioral_evidence: row.get(6)?,
                artifact_path_or_content: row.get(7)?,
                source_run_id: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let entry = row.map_err(|e| e.to_string())?;
        if needle.is_empty()
            || entry.title.to_ascii_lowercase().contains(&needle)
            || entry.domain_tag.to_ascii_lowercase().contains(&needle)
            || entry.component_type.to_ascii_lowercase().contains(&needle)
        {
            out.push(entry);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn harness2_keep(state: State<'_, AppState>, run_id: String) -> Result<RunCard, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut card = row_card(&conn, &run_id)?;
    if card.adopted {
        return Ok(card);
    }
    assert_soft(&card.proposal)?;
    let dir = library_dir(&state.home, &card.bot_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("EXPERIENCE.md");
    let mut body = fs::read_to_string(&path).unwrap_or_default();
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(&format!("\n## {run_id}\n\n{}\n", card.log));
    fs::write(&path, &body).map_err(|e| e.to_string())?;
    let component = card.components.first().cloned().unwrap_or_else(|| "system_prompt".into());
    let entry_id = nid("h2lib");
    conn.execute(
        "INSERT INTO harness2_library_entries (id, bot_id, domain_tag, component_type, title, when_to_apply_rule, behavioral_evidence, artifact_path_or_content, source_run_id, created_at) VALUES (?1,?2,'general',?3,?4,?5,?6,?7,?8,?9)",
        params![
            entry_id,
            card.bot_id,
            component,
            format!("Harness² {}", card.run_id),
            format!("Score {} trigger {}", card.score, card.trigger),
            card.probe_note,
            path.display().to_string(),
            card.run_id,
            now_ms(),
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("UPDATE harness2_runs SET adopted_into_library=1 WHERE id=?1", params![card.run_id]).map_err(|e| e.to_string())?;
    card.adopted = true;
    match remember(
        &conn,
        &MemoryInput {
            id: None,
            title: format!("Harness² {}", card.run_id),
            content_markdown: clip(&card.log, 4000),
            source_type: "harness2".into(),
            scoped_bot_id: Some(card.bot_id.clone()),
            file_path_or_uri: path.display().to_string(),
            engine_id: Some("mem0_builtin".into()),
        },
    ) {
        Ok(saved) => card.probe_note = format!("{}. {}", card.probe_note, saved.note),
        Err(error) => card.probe_note = format!("{}. Memory was not saved: {}", card.probe_note, error.0),
    }
    rewrite_step(&conn, &card)?;
    Ok(card)
}

#[tauri::command]
pub async fn harness2_promote(state: State<'_, AppState>, run_id: String) -> Result<RunCard, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let card = row_card(&conn, &run_id)?;
    if card.promoted {
        return Ok(card);
    }
    assert_soft(&card.proposal)?;
    let soul: String = conn
        .query_row("SELECT soul_markdown FROM bot_profiles WHERE id=?1", params![card.bot_id], |row| row.get(0))
        .map_err(|_| "bot profile was not found".to_string())?;
    let dir = library_dir(&state.home, &card.bot_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let backup = dir.join(format!("soul-backup-{}.md", now_ms()));
    fs::write(&backup, &soul).map_err(|e| e.to_string())?;
    let next = format!("{soul}\n\n## Harness² overlay {}\n\n{}\n", card.run_id, card.proposal);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE bot_profiles SET soul_markdown=?1 WHERE id=?2", params![next, card.bot_id]).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE harness2_runs SET promoted_to_base_profile=1, shadow_git_commit=?1 WHERE id=?2",
        params![backup.display().to_string(), card.run_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut card = row_card(&conn, &run_id)?;
    card.soul_untouched = false;
    rewrite_step(&conn, &card)?;
    Ok(card)
}

#[tauri::command]
pub async fn harness2_revert(state: State<'_, AppState>, run_id: String) -> Result<RunCard, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let card = row_card(&conn, &run_id)?;
    if !card.promoted || card.backup_path.trim().is_empty() {
        return Err("the base soul was not changed by this run".into());
    }
    let backup = PathBuf::from(&card.backup_path);
    let library = library_dir(&state.home, &card.bot_id);
    if !backup.starts_with(&library) {
        return Err("the backup path is outside this bot's library".into());
    }
    let soul = fs::read_to_string(&backup).map_err(|e| format!("backup could not be read: {e}"))?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE bot_profiles SET soul_markdown=?1 WHERE id=?2", params![soul, card.bot_id]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE harness2_runs SET promoted_to_base_profile=0 WHERE id=?1", params![card.run_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let mut card = row_card(&conn, &run_id)?;
    card.soul_untouched = true;
    rewrite_step(&conn, &card)?;
    Ok(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_prompt_stays_under_the_threshold() {
        let score = score_prompt("What time is it?", 0, false, false);
        assert!(score.value < 65, "{}", score.value);
        assert!(score.reasons.iter().any(|reason| reason.contains("no skill")));
    }

    #[test]
    fn reverse_engineer_and_refactor_cross_the_threshold() {
        let score = score_prompt(
            "Reverse engineer the auth module, refactor our Rust middleware, and verify with tests",
            0,
            false,
            false,
        );
        assert!(score.value >= 65, "{}", score.value);
    }

    #[test]
    fn proposal_does_not_claim_a_probe_or_a_passing_test() {
        let score = score_prompt("refactor the parser", 0, false, true);
        let flags = Flags::default();
        let text = proposal_text("refactor the parser", &score, &flags, &flags.components, Path::new("sandbox"));
        let lower = text.to_ascii_lowercase();
        assert!(lower.contains("not an executed edit"));
        assert!(lower.contains("was not modified"));
        assert!(!lower.contains("tests passed"));
        assert!(!lower.contains("probe succeeded"));
    }

    #[test]
    fn unknown_component_is_rejected() {
        let mut flags = Flags::default();
        let error = apply_patch(
            &mut flags,
            FlagPatch {
                mode: None,
                recursion: None,
                budget_k: None,
                threshold: None,
                escalate: None,
                editor_label: None,
                substrate: None,
                components: Some(vec!["wallet".into()]),
            },
        );
        assert!(error.is_err());
    }
}
