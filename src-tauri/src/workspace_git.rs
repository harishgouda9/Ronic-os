use crate::capabilities::SkillDraft;
use crate::db::{self, kv_get};
use crate::error::{err, Result};
use crate::util::{broadcast_to_terminal, run_capture, run_capture_stream, which};
use crate::AppState;
use rusqlite::params;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub fn perform(state: &AppState, action: &str, path: &str, agent: &str, prompt: &str) -> Result<(String, Value)> {
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
        "restore" => restore(&cwd, path, state),
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

fn status(cwd: &Path, state: &AppState) -> Result<(String, Value)> {
    let files = working_tree(cwd)?;
    announce(state, &format!("git status — {} changed file(s) in {}", files.len(), cwd.display()));
    let toast = if files.is_empty() {
        format!("Working tree is clean in {}.", cwd.display())
    } else {
        format!("{} changed file(s) in {}.", files.len(), cwd.display())
    };
    Ok((toast, json!({ "files": files })))
}

fn stage(cwd: &Path, path: &str, state: &AppState) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
    let (code, output) = run_capture(git_bin().as_str(), &["add", "--", &rel], Some(cwd), Duration::from_secs(20))?;
    if code != 0 {
        return Err(err(clip_line(&output)));
    }
    announce(state, &format!("git add -- {rel}"));
    let files = working_tree(cwd)?;
    Ok((format!("Staged {rel}."), json!({ "files": files })))
}

fn restore(cwd: &Path, path: &str, state: &AppState) -> Result<(String, Value)> {
    let rel = safe_rel(path)?;
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

fn dispatch(state: &AppState, cwd: &Path, agent: &str, prompt: &str, binary: &str) -> Result<(String, Value)> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(err("write a task before dispatch"));
    }
    if prompt.len() > 8_000 {
        return Err(err("that task is too long"));
    }
    if matches!(agent, "cursor" | "vscode") {
        let path = binary.trim();
        if path.is_empty() || !Path::new(path).is_file() {
            return Err(err(format!("{agent} is not installed. Scan this computer, or set the program path.")));
        }
        let mut cmd = Command::new(path);
        cmd.arg(cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        match cmd.spawn() {
            Ok(child) => Ok((format!("Opened {agent} at pid {} on {}.", child.id(), cwd.display()), json!({ "files": [] }))),
            Err(error) => Err(err(format!("could not open {agent}: {error}"))),
        }
    } else {
        let program = resolve_cli(binary)?;
        let args = agent_args(agent, prompt)?;
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        announce(state, &format!("$ {program} {}", args.join(" ")));
        let app = state.app_handle.lock().ok().and_then(|g| g.clone());
        let app_stream = app.clone();
        let (code, output) = run_capture_stream(&program, &arg_refs, Some(cwd), Duration::from_secs(180), move |chunk| {
            if let Some(app) = &app_stream {
                broadcast_to_terminal(app, chunk);
            }
        })?;
        let files = working_tree(cwd).unwrap_or_default();
        let toast = if code == 0 {
            format!("{agent} finished. The working tree is refreshed.")
        } else {
            format!("{agent} exited {code}. The working tree is refreshed.")
        };
        Ok((toast, json!({ "files": files, "output": clip_block(&output), "exitCode": code })))
    }
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
    let mut files = Vec::new();
    for (path, staged) in entries.into_iter().take(40) {
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
        let unstaged = git_diff(cwd, &["diff", "-U2", "--", &path])?;
        let cached = git_diff(cwd, &["diff", "--cached", "-U2", "--", &path])?;
        let mut diff = String::new();
        if !cached.trim().is_empty() {
            diff.push_str(&cached);
        }
        if !unstaged.trim().is_empty() {
            if !diff.is_empty() {
                diff.push('\n');
            }
            diff.push_str(&unstaged);
        }
        if diff.trim().is_empty() {
            diff = "(no text diff — binary, untracked, or already matching HEAD)".into();
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

fn parse_porcelain_z(text: &str) -> Vec<(String, bool)> {
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
        let staged = xy[0] != b' ' && xy[0] != b'?';
        if !path.is_empty() {
            out.push((path, staged));
        }
        index += 1;
    }
    out
}

fn agent_args(agent: &str, prompt: &str) -> Result<Vec<String>> {
    match agent {
        "claude" => Ok(vec!["-p".into(), prompt.into(), "--permission-mode".into(), "acceptEdits".into()]),
        "aider" => Ok(vec!["--message".into(), prompt.into(), "--yes".into(), "--no-auto-commits".into()]),
        "codex" => Ok(vec!["exec".into(), prompt.into()]),
        "gemini" => Ok(vec!["-p".into(), prompt.into()]),
        "opencode" => Ok(vec!["run".into(), prompt.into()]),
        _ => Err(err("that agent cannot be dispatched from this screen")),
    }
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
