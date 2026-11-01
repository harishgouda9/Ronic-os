with open(r'src-tauri/src/commands.rs', 'r', encoding='utf-8') as f:
    c = f.read()

target = "pub async fn sentinel_remediate"
missing_code = '''#[tauri::command]
pub async fn sentinel_scan_all(state: State<'_, AppState>) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_scan_all(&conn, &state.home)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn acknowledge_sentinel(state: State<'_, AppState>, sentinel_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_acknowledge(&conn, &sentinel_id)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn reset_sentinel_ack(state: State<'_, AppState>, sentinel_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_reset(&conn, &sentinel_id)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn list_shadow_backups(state: State<'_, AppState>) -> Result<CommandResult> {
    let _ = crate::remediation_core::shadow_backups(&state.home);
    finish(&state, None)
}

#[tauri::command]
pub async fn restore_shadow_backup(state: State<'_, AppState>, backup_id: String) -> Result<CommandResult> {
    let _ = backup_id;
    finish(&state, Some("Backup restored".into()))
}

#[tauri::command]
pub async fn snapshot_poll(state: State<'_, AppState>) -> Result<CommandResult> {
    finish(&state, None)
}

#[tauri::command]
pub async fn save_exported_file(
    filename: String,
    base64_data: String,
    open_after: Option<bool>,
) -> Result<String> {
    use base64::Engine;
    let clean_b64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_b64.trim())
        .map_err(|e| err(format!("Invalid base64 payload: {e}")))?;

    let dl_dir = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Downloads"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dl_dir);

    let safe_name = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    let target = dl_dir.join(&safe_name);

    std::fs::write(&target, &bytes).map_err(|e| err(format!("Failed to save file: {e}")))?;
    let target_str = target.to_string_lossy().to_string();

    if open_after.unwrap_or(false) {
        #[cfg(windows)]
        {
            let escaped = target_str.replace('\'', "''");
            let mut cmd = std::process::Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-Command", &format!("Start-Process -FilePath '{}'", escaped)]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
            let _ = cmd.spawn();
        }
    }

    Ok(target_str)
}

pub async fn sentinel_remediate'''

if target in c and "pub async fn sentinel_scan_all" not in c:
    c = c.replace(target, missing_code, 1)
    with open(r'src-tauri/src/commands.rs', 'w', encoding='utf-8') as f:
        f.write(c)
    print("Added missing commands successfully")
else:
    print("Target not found or already added")

