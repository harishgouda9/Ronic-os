use crate::error::{err, Result};
use rusqlite::{params, Connection};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Structured markdown for one vault note. The fact stays the body.
/// Frontmatter is the id, title, and scope a bot matches on.
// shortcut: the sheet is a render of state.db, upgrade when an agent must patch the file itself
pub fn card(id: &str, title: &str, scope: &str, body: &str) -> String {
    let scope = if scope.trim().is_empty() { "workspace" } else { scope.trim() };
    format!("---\nid: {}\ntitle: {}\nscope: {}\n---\n{}", yaml_value(id), yaml_value(title), yaml_value(scope), body.trim())
}

pub fn publish_note(conn: &Connection, id: &str) -> Result<PathBuf> {
    let (title, body, scope, updated): (String, String, String, i64) = conn.query_row(
        "SELECT title, content_markdown, COALESCE(scoped_bot_id, ''), updated_at FROM memory_items WHERE id=?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let mut stmt = conn.prepare("SELECT relation, target FROM memory_edges WHERE memory_id=?1 ORDER BY updated_at, id")?;
    let links = stmt
        .query_map(params![id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let scope = if scope.trim().is_empty() { "workspace".to_string() } else { scope };
    let mut text = format!(
        "---\nid: {}\ntitle: {}\nscope: {}\nupdated: {updated}\n---\n{}\n",
        yaml_value(id),
        yaml_value(&title),
        yaml_value(&scope),
        body.trim()
    );
    if !links.is_empty() {
        text.push_str("\n## links\n");
        for (relation, target) in links {
            text.push_str(&format!("- {relation} {target}\n"));
        }
    }
    let dest = note_path(conn, id)?;
    atomic_write(&dest, &text)?;
    Ok(dest)
}

pub fn remove_note(conn: &Connection, id: &str) -> Result<()> {
    let dest = note_path(conn, id)?;
    if !dest.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&dest)?.file_type().is_symlink() {
        return Err(err("memory sheet cannot be a symlink"));
    }
    if dest.is_file() {
        fs::remove_file(dest)?;
    }
    Ok(())
}

pub fn publish_always(conn: &Connection) -> Result<()> {
    let dest = memory_root(conn)?.join("always.md");
    atomic_write(&dest, &super::curated::always_document(conn)?)?;
    Ok(())
}

fn note_path(conn: &Connection, id: &str) -> Result<PathBuf> {
    Ok(memory_root(conn)?.join("notes").join(format!("{}.md", safe_id(id))))
}

fn memory_root(conn: &Connection) -> Result<PathBuf> {
    let path = conn.path().filter(|path| !path.is_empty()).ok_or_else(|| err("memory database has no file"))?;
    let parent = Path::new(path).parent().ok_or_else(|| err("memory database has no folder"))?;
    Ok(parent.join("memories"))
}

fn safe_id(id: &str) -> String {
    let cleaned: String = id.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' }).collect();
    if cleaned.is_empty() { "note".into() } else { cleaned }
}

fn yaml_value(value: &str) -> String {
    let flat: String = value.chars().map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch }).collect();
    let plain = !flat.is_empty()
        && !flat.starts_with(' ')
        && !flat.ends_with(' ')
        && !flat.chars().any(|ch| matches!(ch, ':' | '#' | '"' | '\''));
    if plain {
        flat
    } else {
        format!("\"{}\"", flat.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

fn atomic_write(dest: &Path, body: &str) -> Result<()> {
    let parent = dest.parent().ok_or_else(|| err("memory sheet has no folder"))?;
    if parent.exists() && fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err(err("memory sheet folder cannot be a symlink"));
    }
    fs::create_dir_all(parent)?;
    if dest.exists() && fs::symlink_metadata(dest)?.file_type().is_symlink() {
        return Err(err("memory sheet cannot be a symlink"));
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
    let temp = parent.join(format!(".sheet-{}-{nonce}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, dest)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db;
    use crate::memory::{curate, forget, link_graph, remember, MemoryInput};
    use crate::util::nid;

    #[test]
    fn a_saved_note_is_a_structured_sheet_and_forget_removes_it() {
        let dir = std::env::temp_dir().join(nid("ronicsheet"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("state.db")).unwrap();
        db::migrate(&conn).unwrap();
        let saved = remember(
            &conn,
            &MemoryInput {
                id: None,
                title: "Preferred stack".into(),
                content_markdown: "Use Tauri and local SQLite.".into(),
                source_type: "manual".into(),
                scoped_bot_id: None,
                file_path_or_uri: String::new(),
                engine_id: None,
                keep_identity: true,
            },
        )
        .unwrap();
        link_graph(&conn, &saved.id, "SQLite", "STORES", false, None).unwrap();
        let sheet = std::fs::read_to_string(dir.join("memories").join("notes").join(format!("{}.md", saved.id))).unwrap();
        assert!(sheet.starts_with("---\n"), "{sheet}");
        assert!(sheet.contains(&format!("id: {}", saved.id)), "{sheet}");
        assert!(sheet.contains("title: Preferred stack"), "{sheet}");
        assert!(sheet.contains("scope: workspace"), "{sheet}");
        assert!(sheet.contains("Use Tauri and local SQLite."), "{sheet}");
        assert!(sheet.contains("## links\n- STORES SQLite"), "{sheet}");
        assert!(!sheet.contains("sync_json"), "{sheet}");

        curate(&conn, "user", "add", "", "Prefers short answers.", None).unwrap();
        let always = std::fs::read_to_string(dir.join("memories").join("always.md")).unwrap();
        assert!(always.contains("kind: always"), "{always}");
        assert!(always.contains("## user "), "{always}");
        assert!(always.contains("- Prefers short answers."), "{always}");

        forget(&conn, &saved.id, None).unwrap();
        assert!(!dir.join("memories").join("notes").join(format!("{}.md", saved.id)).exists());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
