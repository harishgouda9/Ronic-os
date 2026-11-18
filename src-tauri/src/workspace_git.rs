use crate::capabilities::SkillDraft;
use crate::db::{self, kv_get};
use crate::error::{err, Result};
use crate::redact::redact;
use crate::util::{broadcast_to_terminal, confined_join, run_capture, run_capture_stream_env_cancel, which};
use crate::workspace_bridge;
use crate::AppState;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

static MODELS_CACHE: Mutex<Vec<(String, Instant, Vec<Value>)>> = Mutex::new(Vec::new());
static CANCEL_DISPATCH: AtomicBool = AtomicBool::new(false);

pub fn perform(state: &AppState, action: &str, path: &str, agent: &str, prompt: &str) -> Result<(String, Value)> {
    if action == "cancel" {
        CANCEL_DISPATCH.store(true, Ordering::SeqCst);
        return Ok(("Stopping active coding agent…".into(), json!({ "cancelled": true })));
    }
    let (cwd, settings_agent) = {
        let conn = guard(state);
        let settings = db::settings_of(&conn).unwrap_or_default();
        let cwd = project_dir(&settings.project_root, &state.home);
        let binary = match agent {
            "claude" => settings.claude_path,
            "aider" => settings.aider_path,
            "opencode" => settings.opencode_path,
            "codex" => settings.codex_path,
            "gemini" => settings.gemini_path,
            "cursor" => app_path(&conn, "app_cursor"),
            "vscode" => app_path(&conn, "app_vscode"),
            _ => String::new(),
        };
        (cwd, binary)
    };
    match action {
        "status" => status(&cwd, state),
        "stage" => stage(&cwd, path, state),
        "unstage" => unstage(&cwd, path, state),
        "stage_all" => stage_all(&cwd, state),
        "restore" => restore(&cwd, path, state),
        "commit" => commit(&cwd, prompt, state),
        "git_init" => git_init(&cwd, state),
        "tree" => project_tree(&cwd, path),
        "read_file" => read_project_file(&cwd, path),
        "write_file" => write_project_file(&cwd, path, prompt),
        "sync_harness" => sync_harness(state, &cwd, agent, &settings_agent),
        "list_models" => list_harness_models(agent, &settings_agent, path == "refresh"),
        "dispatch" => dispatch(state, &cwd, agent, prompt, &settings_agent),
        _ => Err(err("unknown git action")),
    }
}

pub fn install_package(state: &AppState, url: &str, profile_id: &str) -> Result<String> {
    let (clone_url, repo) = github_clone_target(url)?;
    let dest = state.home.join("plugins").join(&repo);
    if !dest.join(".git").is_dir() {
        fs::create_dir_all(state.home.join("plugins"))?;
        if dest.exists() {
            return Err(err(format!("{} already exists and is not a git checkout", dest.display())));
        }
        let (code, output) = run_capture(
            git_bin().as_str(),
            &["clone", "--depth", "1", &clone_url, &dest.display().to_string()],
            None,
            Duration::from_secs(120),
        )?;
        if code != 0 {
            let _ = fs::remove_dir_all(&dest);
            return Err(err(format!("git clone failed: {}", output.lines().last().unwrap_or("no output"))));
        }
    }
    let skills = find_skills(&dest);
    if skills.is_empty() {
        return Ok(format!("Cloned {clone_url} to {}. No SKILL.md was in the repository, so no skill was registered.", dest.display()));
    }
    let profile = {
        let conn = guard(state);
        let given = profile_id.trim();
        if given.is_empty() {
            kv_get(&conn, "active_profile")?.unwrap_or_default()
        } else {
            given.to_string()
        }
    };
    if profile.is_empty() {
        return Ok(format!(
            "Cloned {clone_url} to {}. Found {} SKILL.md file(s). Pick a bot under Mount to, then install again.",
            dest.display(),
            skills.len()
        ));
    }
    let mut saved = 0usize;
    let mut skipped = Vec::new();
    {
        let conn = guard(state);
        for skill_path in &skills {
            let body = fs::read_to_string(skill_path).unwrap_or_default();
            if body.trim().is_empty() || body.len() > 80_000 {
                skipped.push(skill_path.display().to_string());
                continue;
            }
            let folder = skill_path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("skill");
            let name = frontmatter(&body, "name");
            let slug = sanitize_slug(if name.is_empty() { folder } else { &name });
            if slug.is_empty() {
                skipped.push(skill_path.display().to_string());
                continue;
            }
            let description = {
                let found = frontmatter(&body, "description");
                if found.is_empty() { format!("Skill from {clone_url}") } else { found }
            };
            let draft = SkillDraft {
                profile_id: profile.clone(),
                slug: slug.clone(),
                title: if name.is_empty() { slug.clone() } else { name },
                description: description.clone(),
                slash_command: format!("/{slug}"),
                platforms: vec!["windows".into(), "macos".into(), "linux".into()],
                body,
                ..SkillDraft::default()
            };
            match crate::capabilities::save_skill(&conn, &state.home, draft) {
                Ok(()) => saved += 1,
                Err(error) => skipped.push(format!("{slug}: {}", error.0)),
            }
        }
    }
    let mut note = format!("Cloned {clone_url}. Saved {saved} skill(s) for the selected bot.");
    if !skipped.is_empty() {
        note.push_str(&format!(" Skipped {}: {}.", skipped.len(), skipped.join("; ")));
    }
    Ok(note)
}

fn current_branch(cwd: &Path) -> String {
    if !cwd.join(".git").exists() {
        return String::new();
    }
    let Ok((code, out)) = run_capture(
        git_bin().as_str(),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        Some(cwd),
        Duration::from_secs(10),
    ) else {
        return String::new();
    };
    if code == 0 { out.trim().to_string() } else { String::new() }
}

fn status(cwd: &Path, state: &AppState) -> Result<(String, Value)> {
    let is_git = cwd.join(".git").exists();
    if !is_git {
        return Ok((
            "Not a git repository yet. Browse project files or initialize git.".into(),
            json!({
                "files": [],
                "isGit": false,
                "branch": "",
                "projectRoot": cwd.display().to_string(),
            }),
        ));
    }
    let files = working_tree(cwd)?;
    let branch = current_branch(cwd);
    announce(state, &format!("git status — {} changed file(s) in {}", files.len(), cwd.display()));
    let toast = if files.is_empty() {
        format!("Working tree is clean in {}.", cwd.display())
    } else {
        format!("{} changed file(s) in {}.", files.len(), cwd.display())
    };
    Ok((
        toast,
        json!({
            "files": files,
            "isGit": true,
            "branch": branch,
            "projectRoot": cwd.display().to_string(),
        }),
    ))
}

fn stage(cwd: &Path, path: &str, state: &AppState) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
    let (code, output) = run_capture(git_bin().as_str(), &["add", "--", &rel], Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, &format!("git add -- {rel}"));
    let files = working_tree(cwd)?;
    Ok((format!("Staged {rel}."), json!({ "files": files, "isGit": true, "branch": current_branch(cwd) })))
}

fn unstage(cwd: &Path, path: &str, state: &AppState) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
    let (code, output) = run_capture(
        git_bin().as_str(),
        &["restore", "--staged", "--", &rel],
        Some(cwd),
        Duration::from_secs(20),
    )?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, &format!("git restore --staged -- {rel}"));
    let files = working_tree(cwd)?;
    Ok((format!("Unstaged {rel}."), json!({ "files": files, "isGit": true, "branch": current_branch(cwd) })))
}

fn stage_all(cwd: &Path, state: &AppState) -> Result<(String, Value)> {
    let (code, output) = run_capture(git_bin().as_str(), &["add", "-A"], Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, "git add -A");
    let files = working_tree(cwd)?;
    Ok(("Staged all changes.".into(), json!({ "files": files, "isGit": true, "branch": current_branch(cwd) })))
}

fn commit(cwd: &Path, message: &str, state: &AppState) -> Result<(String, Value)> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(err("Write a commit message first."));
    }
    if msg.len() > 2000 {
        return Err(err("Commit message is too long."));
    }
    let (code, output) = run_capture(git_bin().as_str(), &["commit", "-m", msg], Some(cwd), Duration::from_secs(30))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, &format!("git commit -m \"{msg}\""));
    let files = working_tree(cwd).unwrap_or_default();
    Ok((clip_line(&output), json!({ "files": files, "isGit": true, "branch": current_branch(cwd) })))
}

fn git_init(cwd: &Path, state: &AppState) -> Result<(String, Value)> {
    let (code, output) = run_capture(git_bin().as_str(), &["init"], Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, &format!("git init in {}", cwd.display()));
    let files = working_tree(cwd).unwrap_or_default();
    Ok((
        format!("Initialized git repository in {}.", cwd.display()),
        json!({ "files": files, "isGit": true, "branch": current_branch(cwd) }),
    ))
}

fn restore(cwd: &Path, path: &str, state: &AppState) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
    if working_tree_entries(cwd)?.into_iter().any(|entry| same_rel(&entry.path, &rel) && entry.untracked) {
        return Err(err("This file is new. Restore only puts a tracked file back. It was left on disk."));
    }
    let (code, output) = run_capture(
        git_bin().as_str(),
        &["restore", "--source=HEAD", "--worktree", "--staged", "--", &rel],
        Some(cwd),
        Duration::from_secs(20),
    )?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, &format!("git restore -- {rel}"));
    let files = working_tree(cwd)?;
    Ok((format!("Restored {rel} from the last commit. Untracked files stay on disk."), json!({ "files": files })))
}

fn ignored_tree_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".nuxt" | ".venv" | "venv" | "__pycache__" | ".cache"
    )
}

fn project_tree(cwd: &Path, rel: &str) -> Result<(String, Value)> {
    let root = cwd.canonicalize().map_err(|_| err("Project folder is not readable."))?;
    let clean = rel.trim().replace('\\', "/").trim_matches('/').to_string();
    let target = if clean.is_empty() || clean == "." {
        root.clone()
    } else {
        let safe = safe_rel(&clean)?;
        let candidate = root.join(&safe).canonicalize().map_err(|_| err(format!("Folder '{safe}' not found.")))?;
        if !candidate.starts_with(&root) {
            return Err(err("That path is outside the project."));
        }
        candidate
    };
    if !target.is_dir() {
        return Err(err("Path is not a directory."));
    }
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries = fs::read_dir(&target).map_err(|e| err(format!("Could not read folder: {e}")))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if secret_path(&name) {
            continue;
        }
        let full = entry.path();
        let is_dir = full.is_dir();
        if is_dir && ignored_tree_dir(&name) {
            continue;
        }
        let item_rel = if clean.is_empty() || clean == "." {
            name.clone()
        } else {
            format!("{clean}/{name}")
        };
        let size = if is_dir {
            0
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let row = json!({
            "name": name,
            "path": item_rel,
            "isDir": is_dir,
            "size": size,
        });
        if is_dir {
            dirs.push((name.to_ascii_lowercase(), row));
        } else {
            files.push((name.to_ascii_lowercase(), row));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut combined: Vec<Value> = dirs.into_iter().map(|(_, v)| v).collect();
    combined.extend(files.into_iter().map(|(_, v)| v));
    combined.truncate(300);
    Ok((
        String::new(),
        json!({
            "entries": combined,
            "path": clean,
            "projectRoot": cwd.display().to_string(),
        }),
    ))
}

fn read_project_file(cwd: &Path, path: &str) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
    if secret_path(&rel) {
        return Err(err("Secret files (.env, keys, vaults) are hidden in the workspace viewer."));
    }
    let root = cwd.canonicalize().map_err(|_| err("Project folder is not readable."))?;
    let full = root.join(&rel).canonicalize().map_err(|_| err(format!("File '{rel}' not found.")))?;
    if !full.starts_with(&root) {
        return Err(err("That path is outside the project."));
    }
    if full.is_dir() {
        return Err(err(format!("'{rel}' is a folder.")));
    }
    let meta = fs::metadata(&full).map_err(|e| err(format!("Could not read file: {e}")))?;
    let size = meta.len();
    if size > 300_000 {
        return Ok((
            String::new(),
            json!({
                "path": rel,
                "content": format!("(File is {} bytes — too large for inline viewer)", size),
                "size": size,
                "lines": 0,
                "binary": false,
                "truncated": true,
            }),
        ));
    }
    let bytes = fs::read(&full).map_err(|e| err(format!("Could not read file: {e}")))?;
    if bytes.contains(&0) {
        return Ok((
            String::new(),
            json!({
                "path": rel,
                "content": format!("(Binary file — {} bytes)", size),
                "size": size,
                "lines": 0,
                "binary": true,
                "truncated": false,
            }),
        ));
    }
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let clean = redact(&raw);
    let lines = clean.lines().count();
    Ok((
        String::new(),
        json!({
            "path": rel,
            "content": clean,
            "size": size,
            "lines": lines,
            "binary": false,
            "truncated": false,
        }),
    ))
}

fn write_project_file(cwd: &Path, path: &str, content: &str) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
    if secret_path(&rel) {
        return Err(err("Secret files cannot be edited from the inline viewer."));
    }
    if content.len() > 500_000 {
        return Err(err("File content exceeds 500KB limit."));
    }
    let target = confined_join(cwd, &rel)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target, content.as_bytes())?;
    Ok((
        format!("Saved {rel}."),
        json!({ "path": rel, "bytes": content.len() }),
    ))
}

fn sync_harness(state: &AppState, cwd: &Path, agent: &str, binary: &str) -> Result<(String, Value)> {
    let report = {
        let conn = guard(state);
        workspace_bridge::sync_harness_capabilities(&conn, &state.home, agent, binary, &cwd.display().to_string())
            .map_err(err)?
    };
    let skills = report.get("skillsCount").and_then(Value::as_u64).unwrap_or(0);
    let plugins = report.get("pluginsCount").and_then(Value::as_u64).unwrap_or(0);
    let mcps = report.get("mcpCount").and_then(Value::as_u64).unwrap_or(0);
    let toast = format!("Synced {agent} with Ronic OS ({skills} skills, {plugins} plugins, {mcps} MCPs).");
    Ok((toast, json!({ "sync": report })))
}

fn model_tier(id: &str, label: &str) -> &'static str {
    let s = format!("{} {}", id.to_ascii_lowercase(), label.to_ascii_lowercase());
    if s.contains("low") || s.contains("haiku") || s.contains("lite") || s.contains("mini") || s.contains("flash") {
        "fast"
    } else if s.contains("opus") || s.contains("pro") || s.contains("high") || s.contains("max") || s.contains("o3") {
        "deep"
    } else {
        "balanced"
    }
}

fn parse_cli_models(output: &str, source: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("Fetching")
            || trimmed.starts_with("Usage")
            || trimmed.starts_with("Available")
            || trimmed.starts_with("Error")
        {
            continue;
        }
        let (id, label) = if let Some((left, right)) = trimmed.split_once('\t') {
            (left.trim(), right.trim())
        } else {
            let first = trimmed.split_whitespace().next().unwrap_or("");
            if first.is_empty() || first.starts_with('-') || first.len() > 80 {
                continue;
            }
            (first, first)
        };
        if id.is_empty() || id.contains(' ') || seen.iter().any(|s: &String| s == id) {
            continue;
        }
        seen.push(id.to_string());
        out.push(json!({
            "id": id,
            "label": if label.is_empty() { id } else { label },
            "tier": model_tier(id, label),
            "source": source,
        }));
    }
    out
}

fn preset_models_for(agent: &str, binary: &str) -> Vec<Value> {
    let rows: &[(&str, &str, &str)] = match agent {
        "claude" => &[
            ("haiku", "Claude Haiku (Fastest)", "fast"),
            ("sonnet", "Claude Sonnet (Balanced)", "balanced"),
            ("opus", "Claude Opus (Deep)", "deep"),
            ("claude-haiku-4-5", "Claude Haiku 4.5", "fast"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6", "balanced"),
            ("claude-opus-4-6", "Claude Opus 4.6", "deep"),
        ],
        "gemini" if workspace_bridge::is_agy_binary(binary) => &[
            ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low · Fastest)", "fast"),
            ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)", "balanced"),
            ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", "deep"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", "balanced"),
            ("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", "deep"),
            ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", "balanced"),
        ],
        "gemini" => &[
            ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite (Fastest)", "fast"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash (Fast)", "fast"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro (Deep)", "deep"),
        ],
        "codex" => &[
            ("o4-mini", "o4-mini (Fast)", "fast"),
            ("gpt-5-mini", "GPT-5 Mini (Fast)", "fast"),
            ("gpt-4.1-mini", "GPT-4.1 Mini (Fast)", "fast"),
            ("gpt-5", "GPT-5 (Balanced)", "balanced"),
            ("gpt-4.1", "GPT-4.1 (Balanced)", "balanced"),
            ("o3", "o3 (Deep)", "deep"),
        ],
        "aider" => &[
            ("claude-haiku-4-5", "Claude Haiku 4.5 (Fast)", "fast"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6", "balanced"),
            ("gemini/gemini-2.5-flash", "Gemini 2.5 Flash (Fast)", "fast"),
            ("gpt-4.1-mini", "GPT-4.1 Mini (Fast)", "fast"),
            ("gpt-4.1", "GPT-4.1", "balanced"),
            ("o4-mini", "o4-mini", "fast"),
        ],
        "opencode" => &[
            ("google/gemini-2.5-flash", "Gemini 2.5 Flash (Fast)", "fast"),
            ("anthropic/claude-haiku-4-5", "Claude Haiku 4.5 (Fast)", "fast"),
            ("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", "balanced"),
            ("openai/o4-mini", "o4-mini (Fast)", "fast"),
            ("openai/gpt-5", "GPT-5", "balanced"),
        ],
        _ => &[
            ("auto", "Auto (Harness Default)", "balanced"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6", "balanced"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash (Fast)", "fast"),
            ("gpt-5", "GPT-5", "balanced"),
        ],
    };
    rows.iter()
        .map(|(id, label, tier)| json!({ "id": id, "label": label, "tier": tier, "source": "preset" }))
        .collect()
}

fn list_harness_models(agent: &str, binary: &str, force_refresh: bool) -> Result<(String, Value)> {
    let key = format!("{agent}|{}", binary.trim());
    if !force_refresh {
        let cache = MODELS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, at, cached)) = cache.iter().find(|(k, _, _)| k == &key) {
            if at.elapsed() < Duration::from_secs(300) {
                return Ok((String::new(), json!({ "agent": agent, "models": cached, "cached": true })));
            }
        }
    }

    let mut discovered: Vec<Value> = Vec::new();
    let bin = binary.trim();
    if !bin.is_empty() && !bin.starts_with("wsl:") && Path::new(bin).is_file() {
        if agent == "gemini" && workspace_bridge::is_agy_binary(bin) {
            if let Ok((_, out)) = run_capture(bin, &["models"], None, Duration::from_secs(8)) {
                discovered = parse_cli_models(&out, "cli");
            }
        } else if agent == "opencode" {
            if let Ok((0, out)) = run_capture(bin, &["models"], None, Duration::from_secs(6)) {
                discovered = parse_cli_models(&out, "cli");
            }
        }
    }

    let models = if discovered.is_empty() {
        preset_models_for(agent, bin)
    } else {
        discovered
    };
    {
        let mut cache = MODELS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.retain(|(k, _, _)| k != &key);
        cache.push((key, Instant::now(), models.clone()));
        if cache.len() > 16 {
            cache.remove(0);
        }
    }
    Ok((String::new(), json!({ "agent": agent, "models": models, "cached": false })))
}

struct DispatchRequest {
    text: String,
    inject_context: bool,
    auto_approve: bool,
    fast_context: bool,
    model: String,
    effort: String,
    history_summary: String,
    attached_files: Vec<String>,
    selected_skills: Vec<String>,
}

fn parse_dispatch_input(raw: &str) -> DispatchRequest {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            if val.get("__ronicDispatch").and_then(Value::as_bool) == Some(true) {
                let text = val.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let inject_context = val.get("injectContext").and_then(Value::as_bool).unwrap_or(true);
                let auto_approve = val.get("autoApprove").and_then(Value::as_bool).unwrap_or(true);
                let fast_context = val.get("fastContext").and_then(Value::as_bool).unwrap_or(true);
                let model = val.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let effort = val.get("effort").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let history_summary = val.get("historySummary").and_then(Value::as_str).unwrap_or("").to_string();
                let attached_files = val
                    .get("attachedFiles")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let selected_skills = val
                    .get("selectedSkills")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                return DispatchRequest {
                    text,
                    inject_context,
                    auto_approve,
                    fast_context,
                    model,
                    effort,
                    history_summary,
                    attached_files,
                    selected_skills,
                };
            }
        }
    }
    DispatchRequest {
        text: trimmed.to_string(),
        inject_context: true,
        auto_approve: true,
        fast_context: true,
        model: String::new(),
        effort: String::new(),
        history_summary: String::new(),
        attached_files: Vec::new(),
        selected_skills: Vec::new(),
    }
}

fn dispatch(state: &AppState, cwd: &Path, agent: &str, raw_prompt: &str, binary: &str) -> Result<(String, Value)> {
    let req = parse_dispatch_input(raw_prompt);
    if req.text.is_empty() {
        return Err(err("write a task before dispatch"));
    }
    if req.text.len() > 8_000 {
        return Err(err("that task is too long"));
    }

    // Fast cached sync (0ms when synced recently) + lean prompt when fast_context is ON.
    let (sync_report, final_prompt, context_file) = {
        let conn = guard(state);
        let cwd_str = cwd.display().to_string();
        let sync = workspace_bridge::sync_harness_capabilities_fast(&conn, &state.home, agent, binary, &cwd_str)
            .unwrap_or_else(|_| json!({}));
        let ctx_path = sync
            .get("contextFile")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // Aider has no native MCP, so always give it full inline context when inject_context is on.
        let use_fast = req.fast_context && agent != "aider";
        let prompt_body = if req.inject_context {
            workspace_bridge::build_coding_dispatch_prompt(
                &conn,
                &state.home,
                &cwd_str,
                &req.text,
                &req.history_summary,
                &req.attached_files,
                &req.selected_skills,
                use_fast,
            )
        } else {
            req.text.clone()
        };
        (sync, prompt_body, ctx_path)
    };

    if matches!(agent, "cursor" | "vscode") {
        let path = binary.trim();
        if path.is_empty() || !Path::new(path).is_file() {
            return Err(err(format!("{agent} is not installed. Scan this computer, or set the program path.")));
        }
        if agent == "cursor" {
            if let Some(agent_bin) = cursor_agent_program(path) {
                let program = agent_bin.display().to_string();
                let mut args = vec!["-p".into()];
                if !req.model.is_empty() && req.model != "auto" {
                    args.push("--model".into());
                    args.push(req.model.clone());
                }
                if req.auto_approve {
                    args.push("--force".into());
                }
                args.push(prompt_for_program(&program, &final_prompt)?);
                return run_cli(state, cwd, agent, &req.model, &program, args, &context_file, sync_report);
            }
        }
        crate::workspace_apps::open_program_at(Path::new(path), Some(cwd))
            .map_err(|error| err(format!("could not open {agent}: {}", error.0)))?;
        let files = working_tree(cwd).unwrap_or_default();
        Ok((
            format!("Opened {agent} in {} with Ronic OS MCP synced. The task is in the session log.", cwd.display()),
            json!({ "files": files, "output": req.text, "opened": true, "sync": sync_report, "model": req.model }),
        ))
    } else {
        let program = resolve_cli(binary)?;
        let prompt_arg = prompt_for_program(&program, &final_prompt)?;
        let args = agent_args_for(
            agent,
            &program,
            &prompt_arg,
            req.auto_approve,
            if req.inject_context { &context_file } else { "" },
            &req.model,
            &req.effort,
        )?;
        run_cli(state, cwd, agent, &req.model, &program, args, &context_file, sync_report)
    }
}

fn run_cli(
    state: &AppState,
    cwd: &Path,
    agent: &str,
    model: &str,
    program: &str,
    args: Vec<String>,
    context_file: &str,
    sync_report: Value,
) -> Result<(String, Value)> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let preview_cmd = clip_line(&format!("$ {program} {}", args.join(" ")));
    announce(state, &preview_cmd);
    let app = state.app_handle.lock().ok().and_then(|guard| guard.clone());
    let app_stream = app.clone();
    let agent_name = agent.to_string();
    let model_name = model.to_string();
    let bridge_url = workspace_bridge::status().endpoint;
    let cwd_str = cwd.display().to_string();
    let envs = [
        ("RONIC_OS_MCP_URL", bridge_url.as_str()),
        ("RONIC_OS_CONTEXT_FILE", context_file),
        ("RONIC_OS_PROJECT_ROOT", cwd_str.as_str()),
    ];
    CANCEL_DISPATCH.store(false, Ordering::SeqCst);
    let (code, output) = run_capture_stream_env_cancel(
        program,
        &arg_refs,
        Some(cwd),
        &envs,
        Duration::from_secs(480),
        Some(&CANCEL_DISPATCH),
        move |chunk| {
            if let Some(app) = &app_stream {
                broadcast_to_terminal(app, chunk);
                let _ = app.emit(
                    "coding-agent-stream",
                    json!({ "agent": &agent_name, "model": &model_name, "chunk": chunk, "done": false }),
                );
            }
        },
    )?;
    if let Some(app) = &app {
        let _ = app.emit(
            "coding-agent-stream",
            json!({ "agent": agent, "model": model, "chunk": "", "done": true, "exitCode": code }),
        );
    }
    let files = working_tree(cwd).unwrap_or_default();
    let toast = if code == 130 {
        format!("{agent} cancelled by user.")
    } else if code == 0 {
        format!("{agent} finished. The working tree is refreshed.")
    } else {
        format!("{agent} exited {code}. The working tree is refreshed.")
    };
    Ok((
        toast,
        json!({
            "files": files,
            "output": clip_block(&output),
            "exitCode": code,
            "program": program,
            "model": model,
            "sync": sync_report,
        }),
    ))
}

fn split_unified_diffs(raw: &str) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut current_path: Option<String> = None;
    let mut current_buf = String::new();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(path) = current_path.take() {
                map.insert(path, std::mem::take(&mut current_buf));
            }
            // Handles both unquoted `a/foo b/foo` and quoted `"a/my file.ts" "b/my file.ts"`.
            let parsed = if let Some((_, b)) = rest.split_once(" \"b/") {
                b.trim_end_matches('"').to_string()
            } else if let Some((_, b)) = rest.split_once(" b/") {
                b.trim_matches('"').to_string()
            } else {
                String::new()
            };
            if !parsed.is_empty() {
                current_path = Some(parsed);
            }
        }
        if current_path.is_some() {
            current_buf.push_str(line);
            current_buf.push('\n');
        }
    }
    if let Some(path) = current_path {
        map.insert(path, current_buf);
    }
    map
}

fn working_tree(cwd: &Path) -> Result<Vec<Value>> {
    if !cwd.join(".git").exists() {
        return Err(err(format!("{} is not a git checkout", cwd.display())));
    }
    let (code, output) = run_capture(git_bin().as_str(), &["status", "--porcelain", "-z"], Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    let entries = parse_porcelain_z(&output);
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    // Two batched git diff invocations instead of 2*N per-file spawns (much faster on Windows).
    let unstaged_all = split_unified_diffs(&git_diff(cwd, &["-c", "core.quotepath=false", "diff", "-U2"])?);
    let cached_all = split_unified_diffs(&git_diff(cwd, &["-c", "core.quotepath=false", "diff", "--cached", "-U2"])?);

    let mut files = Vec::new();
    for entry in entries.into_iter().take(40) {
        let path = entry.path;
        let staged = entry.staged;
        let untracked = entry.untracked;
        if secret_path(&path) {
            files.push(json!({
                "path": path,
                "additions": 0,
                "deletions": 0,
                "staged": staged,
                "diff": "(secret file — contents not shown)"
            }));
            continue;
        }
        let norm = path.replace('\\', "/");
        let cached = cached_all.get(&norm).map(String::as_str).unwrap_or("");
        let unstaged = unstaged_all.get(&norm).map(String::as_str).unwrap_or("");
        let mut diff = String::new();
        if !cached.trim().is_empty() {
            diff.push_str(cached);
        }
        if !unstaged.trim().is_empty() {
            if !diff.is_empty() {
                diff.push('\n');
            }
            diff.push_str(unstaged);
        }
        if diff.trim().is_empty() {
            diff = if untracked {
                untracked_preview(cwd, &path)
            } else {
                "(no text diff — binary, or already matching HEAD)".into()
            };
        }
        let (additions, deletions) = count_diff(&diff);
        files.push(json!({
            "path": path,
            "additions": additions,
            "deletions": deletions,
            "staged": staged,
            "diff": clip_block(&diff)
        }));
    }
    Ok(files)
}

fn git_diff(cwd: &Path, args: &[&str]) -> Result<String> {
    let (code, output) = run_capture(git_bin().as_str(), args, Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Ok(String::new());
    }
    Ok(output)
}

struct GitEntry {
    path: String,
    staged: bool,
    untracked: bool,
}

fn working_tree_entries(cwd: &Path) -> Result<Vec<GitEntry>> {
    if !cwd.join(".git").exists() {
        return Err(err(format!("{} is not a git checkout", cwd.display())));
    }
    let (code, output) = run_capture(git_bin().as_str(), &["status", "--porcelain", "-z"], Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    Ok(parse_porcelain_z(&output))
}

fn parse_porcelain_z(text: &str) -> Vec<GitEntry> {
    let mut out = Vec::new();
    let parts: Vec<&str> = text.split('\0').filter(|part| !part.is_empty()).collect();
    let mut index = 0;
    while index < parts.len() {
        let rec = parts[index];
        if rec.len() < 4 {
            index += 1;
            continue;
        }
        let xy = rec.as_bytes();
        let renamed = xy[0] == b'R' || xy[0] == b'C' || xy[1] == b'R' || xy[1] == b'C';
        let mut path = rec[3..].to_string();
        if renamed && index + 1 < parts.len() {
            index += 1;
            path = parts[index].to_string();
        }
        let untracked = xy[0] == b'?' && xy[1] == b'?';
        let staged = xy[0] != b' ' && xy[0] != b'?';
        if !path.is_empty() {
            out.push(GitEntry { path, staged, untracked });
        }
        index += 1;
    }
    out
}

fn valid_model_flag(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") || trimmed.len() > 120 {
        return None;
    }
    if trimmed.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | ';' | '&' | '|')) {
        return None;
    }
    Some(trimmed)
}

fn valid_effort_flag(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

fn agent_args_for(
    agent: &str,
    program: &str,
    prompt: &str,
    auto_approve: bool,
    context_file: &str,
    model: &str,
    effort: &str,
) -> Result<Vec<String>> {
    let picked_model = valid_model_flag(model);
    let picked_effort = valid_effort_flag(effort);
    match agent {
        "claude" => {
            let mut args = vec!["-p".into(), prompt.into(), "--permission-mode".into(), "acceptEdits".into()];
            if let Some(m) = picked_model {
                args.push("--model".into());
                args.push(m.into());
            }
            if let Some(eff) = picked_effort {
                if matches!(eff, "low" | "medium" | "high") {
                    args.push("--effort".into());
                    args.push(eff.into());
                }
            }
            args.push("--allowedTools".into());
            args.push("mcp__ronic-os__*".into());
            if auto_approve {
                args.push("--dangerously-skip-permissions".into());
            }
            Ok(args)
        }
        "aider" => {
            let mut args = vec!["--message".into(), prompt.into(), "--yes".into(), "--no-auto-commits".into()];
            if let Some(m) = picked_model {
                args.push("--model".into());
                args.push(m.into());
            }
            if !context_file.trim().is_empty() && Path::new(context_file).is_file() {
                args.push("--read".into());
                args.push(context_file.into());
            }
            Ok(args)
        }
        "codex" => {
            let mut args = vec!["exec".into()];
            if let Some(m) = picked_model {
                args.push("-m".into());
                args.push(m.into());
            }
            if auto_approve {
                args.push("--full-auto".into());
            }
            args.push(prompt.into());
            Ok(args)
        }
        "gemini" => {
            let mut args = Vec::new();
            let is_agy = workspace_bridge::is_agy_binary(program);
            if let Some(m) = picked_model {
                args.push("--model".into());
                args.push(m.into());
            }
            if is_agy {
                if let Some(eff) = picked_effort {
                    args.push("--effort".into());
                    args.push(eff.into());
                }
            }
            if auto_approve {
                if is_agy {
                    args.push("--dangerously-skip-permissions".into());
                } else {
                    args.push("--yolo".into());
                }
            }
            args.push("-p".into());
            args.push(prompt.into());
            Ok(args)
        }
        "opencode" => {
            let mut args = vec!["run".into()];
            if let Some(m) = picked_model {
                args.push("-m".into());
                args.push(m.into());
            }
            args.push(prompt.into());
            Ok(args)
        }
        _ => Err(err("that agent cannot be dispatched from this screen")),
    }
}

fn prompt_for_program(program: &str, prompt: &str) -> Result<String> {
    let lower = program.to_ascii_lowercase();
    let script = lower.ends_with(".cmd") || lower.ends_with(".bat");
    if !script || !prompt_needs_file(prompt) {
        return Ok(prompt.to_string());
    }
    let path = write_task_file(prompt)?;
    Ok(format!("Read the task in {} and carry it out in this project.", path.display()))
}

fn prompt_needs_file(prompt: &str) -> bool {
    prompt.chars().any(|ch| matches!(ch, '"' | '%' | '&' | '|' | '<' | '>' | '^' | '!' | '\n' | '\r'))
}

fn write_task_file(prompt: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir();
    if let Ok(entries) = fs::read_dir(&dir) {
        let cutoff = std::time::SystemTime::now() - Duration::from_secs(86_400);
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("ronic-task-") && name.ends_with(".txt")) {
                continue;
            }
            let old = entry.metadata().ok().and_then(|meta| meta.modified().ok());
            if old.is_some_and(|stamp| stamp < cutoff) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let path = dir.join(format!("ronic-task-{}.txt", crate::util::now_ms()));
    let text = path.display().to_string();
    if text.chars().any(|ch| matches!(ch, '"' | '%' | '&' | '|' | '<' | '>' | '^' | '!' | '\n' | '\r')) {
        return Err(err("the temp folder path cannot be passed to a Windows script"));
    }
    fs::write(&path, prompt).map_err(|error| err(error.to_string()))?;
    Ok(path)
}

fn cursor_agent_program(cursor_binary: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = Path::new(cursor_binary).parent() {
        dirs.push(parent.to_path_buf());
        dirs.push(parent.join("resources").join("app").join("bin"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local);
        dirs.push(base.join("cursor-agent"));
        dirs.push(base.join("Programs").join("cursor-agent"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(profile);
        dirs.push(home.join(".cursor").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    for dir in dirs {
        for name in ["cursor-agent.exe", "cursor-agent.cmd", "agent.exe", "agent.cmd"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn untracked_preview(cwd: &Path, rel: &str) -> String {
    let full = cwd.join(rel);
    let Ok(root) = cwd.canonicalize() else {
        return "(project folder is not readable)".into();
    };
    let Ok(full) = full.canonicalize() else {
        return "(untracked file is not readable)".into();
    };
    if !full.starts_with(&root) {
        return "(path is outside the project)".into();
    }
    let Ok(meta) = fs::metadata(&full) else {
        return "(untracked file is not readable)".into();
    };
    if meta.is_dir() {
        return "(untracked directory)".into();
    }
    if meta.len() > 200_000 {
        return format!("(untracked, {} bytes — contents not shown)", meta.len());
    }
    let Ok(bytes) = fs::read(&full) else {
        return "(untracked file is not readable)".into();
    };
    if bytes.contains(&0) {
        return "(untracked binary — contents not shown)".into();
    }
    let text = String::from_utf8_lossy(&bytes);
    if text.trim().is_empty() {
        return "(empty new file)".into();
    }
    let mut out = String::from("--- untracked\n+++ untracked\n");
    let mut shown = 0usize;
    for line in text.lines() {
        if shown == 180 {
            out.push_str("+… truncated\n");
            break;
        }
        out.push('+');
        out.push_str(line);
        out.push('\n');
        shown += 1;
    }
    out
}

fn resolve_cli(binary: &str) -> Result<String> {
    let binary = binary.trim();
    if binary.is_empty() {
        return Err(err("this agent is not installed. Scan this computer from Apps, or set its path."));
    }
    if binary.starts_with("wsl:") {
        return Err(err("WSL agents launch from the harness window. This screen runs a local program."));
    }
    if !Path::new(binary).is_file() {
        return Err(err(format!("program not found: {binary}")));
    }
    Ok(binary.to_string())
}

fn project_dir(project_root: &str, home: &Path) -> PathBuf {
    let trimmed = project_root.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
        PathBuf::from(trimmed)
    } else if let Ok(current) = std::env::current_dir() {
        current
    } else {
        home.to_path_buf()
    }
}

fn app_path(conn: &rusqlite::Connection, id: &str) -> String {
    conn.query_row(
        "SELECT executable_path FROM linked_local_apps WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap_or_default()
}

fn git_bin() -> String {
    which("git").or_else(|| which("git.exe")).unwrap_or_else(|| "git".into())
}

fn same_rel(left: &str, right: &str) -> bool {
    left.replace('\\', "/") == right.replace('\\', "/")
}

fn safe_rel(raw: &str) -> Result<String> {
    let raw = raw.trim().replace('\\', "/");
    if raw.is_empty() || raw.starts_with('/') || raw.contains(':') || raw.split('/').any(|part| part == ".." || part.is_empty()) {
        return Err(err("that path is outside the project"));
    }
    Ok(raw)
}

fn secret_path(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
    name == ".env" || name.starts_with(".env.") || name == "secrets.json" || name == "secrets.vault" || name.ends_with(".pem") || name.ends_with(".key")
}

fn count_diff(diff: &str) -> (i64, i64) {
    let mut add = 0i64;
    let mut del = 0i64;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            add += 1;
        } else if line.starts_with('-') {
            del += 1;
        }
    }
    (add, del)
}

fn find_skills(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_skills(root, 0, &mut out);
    out
}

fn walk_skills(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 || out.len() >= 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= 8 {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        if path.is_dir() {
            walk_skills(&path, depth + 1, out);
        } else if name.eq_ignore_ascii_case("SKILL.md") {
            out.push(path);
        }
    }
}

fn frontmatter(body: &str, key: &str) -> String {
    let Some(rest) = body.strip_prefix("---") else { return String::new() };
    let end = rest.find("\n---").unwrap_or(0);
    let prefix = format!("{key}:");
    for line in rest[..end].lines() {
        if let Some(value) = line.trim().strip_prefix(&prefix) {
            return value.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    String::new()
}

fn sanitize_slug(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch == ' ') && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

fn github_clone_target(raw: &str) -> Result<(String, String)> {
    let trimmed = raw.trim().trim_end_matches('/').trim_end_matches(".git");
    let Some(rest) = trimmed.strip_prefix("https://github.com/") else {
        return Err(err("clone URLs must start with https://github.com/"));
    };
    if rest.contains('@') || rest.contains("..") || rest.contains('?') {
        return Err(err("that GitHub URL is not a plain repository"));
    }
    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if owner.is_empty()
        || repo.is_empty()
        || !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || !repo.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(err("that GitHub URL is not a plain repository"));
    }
    Ok((format!("https://github.com/{owner}/{repo}.git"), repo.to_string()))
}

fn announce(state: &AppState, line: &str) {
    if let Some(app) = state.app_handle.lock().ok().and_then(|guard| guard.clone()) {
        broadcast_to_terminal(&app, &format!("\r\n{line}\r\n"));
    }
}

fn clip_line(text: &str) -> String {
    text.lines().find(|line| !line.trim().is_empty()).unwrap_or("git failed").chars().take(240).collect()
}

fn clip_block(text: &str) -> String {
    let mut clipped: String = text.chars().take(12_000).collect();
    if text.chars().count() > 12_000 {
        clipped.push_str("\n… truncated");
    }
    clipped
}

fn guard(state: &AppState) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
    state.conn.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_keeps_the_new_name_and_marks_untracked() {
        let entries = parse_porcelain_z(" M src/a.ts\0?? new file.ts\0R  old.ts\0src/new.ts\0");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "src/a.ts");
        assert!(!entries[0].staged);
        assert!(!entries[0].untracked);
        assert_eq!(entries[1].path, "new file.ts");
        assert!(entries[1].untracked);
        assert!(!entries[1].staged);
        assert_eq!(entries[2].path, "src/new.ts");
        assert!(entries[2].staged);
    }

    #[test]
    fn a_plain_prompt_stays_on_the_command_line() {
        assert!(!prompt_needs_file("fix the login button"));
        assert!(prompt_needs_file("use \"strict\" & tests"));
        assert!(prompt_needs_file("line\ntwo"));
    }

    #[test]
    fn agent_args_apply_headless_permissions_per_harness() {
        let agy = agent_args_for("gemini", r"C:\Users\haris\.gemini\bin\agy.exe", "hi", true, "", "gemini-3.8-flash-low", "low").unwrap();
        assert_eq!(agy, vec!["--model", "gemini-3.8-flash-low", "--effort", "low", "--dangerously-skip-permissions", "-p", "hi"]);
        let gem = agent_args_for("gemini", r"C:\npm\gemini.cmd", "hi", true, "", "gemini-2.5-flash", "low").unwrap();
        assert_eq!(gem, vec!["--model", "gemini-2.5-flash", "--yolo", "-p", "hi"]);
        let gem_safe = agent_args_for("gemini", r"C:\Users\haris\.gemini\bin\agy.exe", "hi", false, "", "", "").unwrap();
        assert_eq!(gem_safe, vec!["-p", "hi"]);
        let claude = agent_args_for("claude", "claude.exe", "hi", true, "", "haiku", "low").unwrap();
        assert!(claude.contains(&"--model".to_string()) && claude.contains(&"haiku".to_string()));
        assert!(claude.contains(&"--effort".to_string()) && claude.contains(&"low".to_string()));
        assert!(claude.contains(&"mcp__ronic-os__*".to_string()));
        assert!(claude.contains(&"--dangerously-skip-permissions".to_string()));
        let codex = agent_args_for("codex", "codex.exe", "hi", true, "", "o4-mini", "").unwrap();
        assert_eq!(codex, vec!["exec", "-m", "o4-mini", "--full-auto", "hi"]);
        let opencode = agent_args_for("opencode", "opencode.exe", "hi", true, "", "anthropic/claude-haiku-4-5", "").unwrap();
        assert_eq!(opencode, vec!["run", "-m", "anthropic/claude-haiku-4-5", "hi"]);
    }

    #[test]
    fn cli_models_and_batched_diffs_parse_cleanly() {
        let parsed = parse_cli_models("Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n", "cli");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["id"], "gemini-3.8-flash-low");
        assert_eq!(parsed[0]["tier"], "fast");
        assert_eq!(parsed[1]["id"], "claude-sonnet-4-6");

        let diff_raw = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+one\ndiff --git \"a/src/my file.ts\" \"b/src/my file.ts\"\n--- \"a/src/my file.ts\"\n+++ \"b/src/my file.ts\"\n-two\n";
        let map = split_unified_diffs(diff_raw);
        assert_eq!(map.len(), 2);
        assert!(map["src/a.ts"].contains("+one"));
        assert!(map["src/my file.ts"].contains("-two"));
    }

    #[test]
    fn dispatch_envelope_parses_structured_and_plain_prompts() {
        let plain = parse_dispatch_input("fix tests");
        assert_eq!(plain.text, "fix tests");
        assert!(plain.inject_context);
        assert!(plain.auto_approve);
        assert!(plain.fast_context);
        let env = parse_dispatch_input(r#"{"__ronicDispatch":true,"text":"refactor","injectContext":false,"autoApprove":false,"fastContext":false,"model":"haiku","effort":"low","attachedFiles":["src/a.ts"],"selectedSkills":["gravitas"]}"#);
        assert_eq!(env.text, "refactor");
        assert!(!env.inject_context);
        assert!(!env.auto_approve);
        assert!(!env.fast_context);
        assert_eq!(env.model, "haiku");
        assert_eq!(env.effort, "low");
        assert_eq!(env.attached_files, vec!["src/a.ts"]);
        assert_eq!(env.selected_skills, vec!["gravitas"]);
    }

    #[test]
    fn tree_and_file_viewer_stay_confined_and_hide_secrets() {
        let dir = std::env::temp_dir().join(format!("ronic-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join(".env"), "API_KEY=secret").unwrap();
        fs::write(dir.join("src").join("app.ts"), "export const ok = 1;\n").unwrap();
        let (_, root_payload) = project_tree(&dir, "").unwrap();
        let entries = root_payload["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "src");
        assert_eq!(entries[0]["isDir"], true);
        let (_, file_payload) = read_project_file(&dir, "src/app.ts").unwrap();
        assert_eq!(file_payload["content"], "export const ok = 1;\n");
        assert!(read_project_file(&dir, ".env").is_err());
        assert!(read_project_file(&dir, "../outside.txt").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
