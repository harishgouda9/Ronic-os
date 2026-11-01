use super::builtin;
use super::obsidian;
#[cfg(test)]
use super::scan::{self, EngineProbe};
use crate::db;
use crate::embed;
use crate::error::{err, Result};
use crate::redact::redact;
use crate::textutil::wikilinks;
use crate::util::{nid, now_ms};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct MemoryInput {
    pub id: Option<String>,
    pub title: String,
    pub content_markdown: String,
    pub source_type: String,
    pub scoped_bot_id: Option<String>,
    pub file_path_or_uri: String,
    pub engine_id: Option<String>,
}

pub struct MemorySaved {
    #[cfg_attr(not(test), allow(dead_code))]
    pub id: String,
    pub note: String,
}

pub fn remember(conn: &Connection, input: &MemoryInput) -> Result<MemorySaved> {
    let title = redact(input.title.trim());
    let content = redact(&input.content_markdown);
    if title.is_empty() {
        return Err(err("memory needs a title"));
    }
    let source = if input.source_type.trim().is_empty() { "manual".to_string() } else { input.source_type.trim().to_string() };
    let links = wikilinks(&content);
    let emb = embed::embed(&content);
    let now = now_ms();
    let existing = input.id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let (id, op, valid_from, has_obsidian_copy, existing_origin) = if let Some(id) = existing {
        let found = conn.query_row(
            "SELECT valid_from, sync_json, engine_origin FROM memory_items WHERE id=?1",
            params![id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        );
        let Ok((prior, sync_json, origin)) = found else { return Err(err("memory was not found")) };
        (id.to_string(), "replace", prior.or(Some(now)), origin == "obsidian_khoj" || synced(&sync_json, "obsidian_khoj"), Some(origin))
    } else {
        (nid("mem"), "remember", Some(now), false, None)
    };
    let engine = resolve_requested_engine(conn, input.engine_id.as_deref(), input.scoped_bot_id.as_deref())?;
    let owner = existing_origin.unwrap_or_else(|| engine.clone());
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO memory_items (id, source_type, scoped_bot_id, file_path_or_uri, title, content_markdown, wikilinks_json, content_hash, updated_at, engine_origin, valid_from, invalid_at, external_id, sync_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,'','{}')
         ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type, scoped_bot_id=excluded.scoped_bot_id, file_path_or_uri=excluded.file_path_or_uri, title=excluded.title, content_markdown=excluded.content_markdown, wikilinks_json=excluded.wikilinks_json, content_hash=excluded.content_hash, updated_at=excluded.updated_at, engine_origin=excluded.engine_origin, sync_json='{}'",
        params![id, source, input.scoped_bot_id, input.file_path_or_uri, title, content, serde_json::to_string(&links)?, content_hash(&content), now, owner, valid_from],
    )?;
    tx.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?1,?2) ON CONFLICT(memory_id) DO UPDATE SET embedding_json=excluded.embedding_json",
        params![id, serde_json::to_string(&emb)?],
    )?;
    tx.execute(
        "INSERT INTO memory_events (id, op, memory_id, payload_json, created_at) VALUES (?1,?2,?3,?4,?5)",
        params![nid("mev"), op, id, serde_json::to_string(&json!({"title": title, "source": source, "engine": engine}))?, now],
    )?;
    tx.commit()?;
    let note = match project_file(conn, &id, &content, &input.file_path_or_uri, &engine, has_obsidian_copy) {
        Ok(extra) => match extra {
            Some(line) => format!("Memory saved. {line}"),
            None => "Memory saved.".into(),
        },
        Err(error) => format!("Memory saved. Vault write failed: {error}"),
    };
    Ok(MemorySaved { id, note })
}

pub fn forget(conn: &Connection, id: &str, engine_id: Option<&str>) -> Result<()> {
    let id = id.trim();
    if id.is_empty() {
        return Err(err("memory was not found"));
    }
    let located: Option<(String, String, String)> = conn
        .query_row(
            "SELECT file_path_or_uri, engine_origin, sync_json FROM memory_items WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    let Some((file_path, engine_origin, sync_json)) = located else { return Err(err("memory was not found")) };
    if let Some(engine_id) = engine_id.map(str::trim).filter(|engine| !engine.is_empty()) {
        if !memory_in_engine(&engine_origin, &sync_json, engine_id) {
            return Err(err("memory belongs to a different vault"));
        }
    }
    if engine_origin == "obsidian_khoj" || synced(&sync_json, "obsidian_khoj") {
        if let Some(vault) = vault_dir(conn) {
            obsidian::remove_note(&vault, &file_path)?;
        } else if engine_origin == "obsidian_khoj" {
            return Err(err("Obsidian vault folder is missing, so this note was not deleted."));
        }
    }
    let now = now_ms();
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM memory_embeddings WHERE memory_id=?1", params![id])?;
    let removed = tx.execute("DELETE FROM memory_items WHERE id=?1", params![id])?;
    if removed == 0 {
        return Err(err("memory was not found"));
    }
    tx.execute(
        "INSERT INTO memory_events (id, op, memory_id, payload_json, created_at) VALUES (?1,'forget',?2,'{}',?3)",
        params![nid("mev"), id, now],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn prompt_context(conn: &Connection, prompt: &str, bot_id: Option<&str>) -> String {
    let engine = resolve_engine(conn, bot_id).unwrap_or_else(|_| builtin_engine());
    let block = builtin::prompt_block(conn, prompt, &engine, bot_id);
    if engine == "mem0_builtin" || engine == "openmemory_builtin" || engine == "obsidian_khoj" {
        block
    } else {
        format!("Active engine is not attached. Showing the Mem0 vault.\n{block}")
    }
}

pub fn search_vault(conn: &Connection, query: &str) -> Result<Value> {
    let engine = resolve_engine(conn, None).unwrap_or_else(|_| builtin_engine());
    let hits = builtin::search_notes(conn, query, &engine, 20)
        .into_iter()
        .map(|note| {
            json!({
                "id": note.id,
                "title": note.title,
                "content": clip_note(&note.content, 280),
                "score": note.score,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "hits": hits, "engine": engine }))
}

pub fn journal(conn: &Connection) -> Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT id, op, memory_id, payload_json, created_at FROM memory_events ORDER BY created_at DESC LIMIT 40",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let (id, op, memory_id, payload_json, created_at) = row?;
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        events.push(json!({
            "id": id,
            "op": op,
            "memoryId": memory_id,
            "title": payload.get("title").and_then(|value| value.as_str()).unwrap_or(""),
            "source": payload.get("source").and_then(|value| value.as_str()).unwrap_or(""),
            "createdAt": created_at,
        }));
    }
    Ok(json!({ "events": events }))
}

fn clip_note(text: &str, limit: usize) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.len() >= limit {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

pub fn set_route(conn: &Connection, scope: &str, engine_id: &str) -> Result<String> {
    let engine_id = engine_id.trim();
    let (id, scope_kind) = if scope.trim() == "global" {
        ("global".to_string(), "global")
    } else {
        let scope = scope.trim();
        let found: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![scope], |row| row.get(0))?;
        if found == 0 {
            return Err(err("unknown bot profile"));
        }
        (scope.to_string(), "bot")
    };
    let availability: String = conn
        .query_row("SELECT availability FROM memory_engines WHERE id=?1", params![engine_id], |row| row.get(0))
        .map_err(|_| err("that engine is not installed"))?;
    if availability == "missing" || availability.is_empty() {
        return Err(err("that engine is not installed"));
    }
    if engine_id != "mem0_builtin" && engine_id != "obsidian_khoj" {
        return Err(err("driver not attached"));
    }
    if engine_id == "obsidian_khoj" && vault_dir(conn).is_none() {
        return Err(err("Obsidian needs a vault folder before it can be the active engine."));
    }
    let refresh_note = refresh_vault(conn, engine_id)?;
    conn.execute(
        "INSERT INTO memory_routes (id, scope, engine_id, companion_engine_id, updated_at) VALUES (?1,?2,?3,NULL,?4)
         ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, engine_id=excluded.engine_id, updated_at=excluded.updated_at",
        params![id, scope_kind, engine_id, now_ms()],
    )?;
    Ok(refresh_note)
}

pub fn mount_companion(conn: &Connection, engine_id: &str) -> Result<()> {
    if engine_id != "obsidian_khoj" {
        return Err(err("only the Obsidian vault can be mounted as a companion"));
    }
    let availability: String = conn
        .query_row("SELECT availability FROM memory_engines WHERE id='obsidian_khoj'", [], |row| row.get(0))
        .unwrap_or_else(|_| "missing".into());
    if availability == "missing" {
        return Err(err("that engine is not installed"));
    }
    if vault_dir(conn).is_none() {
        return Err(err("Obsidian needs a vault folder before it can be mounted."));
    }
    conn.execute(
        "UPDATE memory_routes SET companion_engine_id='obsidian_khoj', updated_at=?1 WHERE id='global'",
        params![now_ms()],
    )?;
    Ok(())
}

pub fn unmount_companion(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE memory_routes SET companion_engine_id=NULL, updated_at=?1 WHERE id='global'", params![now_ms()])?;
    Ok(())
}

pub fn sync_to_engine(conn: &Connection, target: &str) -> Result<String> {
    match target {
        "mem0_builtin" => Ok("Mem0 already stores these notes in the workspace vault.".into()),
        "obsidian_khoj" => hydrate_obsidian(conn),
        _ => Err(err("driver not attached")),
    }
}

pub fn refresh_active_vault(conn: &Connection) -> Result<String> {
    let engine = resolve_engine(conn, None)?;
    refresh_vault(conn, &engine)
}

pub fn refresh_vault(conn: &Connection, engine_id: &str) -> Result<String> {
    match engine_id.trim() {
        "mem0_builtin" => {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memory_items WHERE engine_origin='mem0_builtin'",
                [],
                |row| row.get(0),
            )?;
            Ok(format!("Mem0 vault is ready with {count} note{}.", if count == 1 { "" } else { "s" }))
        }
        "obsidian_khoj" => refresh_obsidian_vault(conn),
        _ => Err(err("driver not attached")),
    }
}

fn hydrate_obsidian(conn: &Connection) -> Result<String> {
    let Some(vault) = vault_dir(conn) else {
        return Err(err("Obsidian needs a vault folder before notes can be copied."));
    };
    let mut stmt = conn.prepare("SELECT id, content_markdown, file_path_or_uri, sync_json FROM memory_items ORDER BY updated_at")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?;
    let mut wrote = 0i64;
    let mut skipped = 0i64;
    for row in rows {
        let (id, content, file_path, sync_json) = row?;
        if synced(&sync_json, "obsidian_khoj") {
            skipped += 1;
            continue;
        }
        let rel = relative_path(&id, &file_path);
        obsidian::write_note(&vault, &rel, &content)?;
        if file_path.is_empty() {
            conn.execute("UPDATE memory_items SET file_path_or_uri=?1 WHERE id=?2", params![rel, id])?;
        }
        mark_synced(conn, &id, "obsidian_khoj", &rel)?;
        wrote += 1;
    }
    Ok(format!("Copied {wrote} notes into the vault. {skipped} were already there."))
}

const MAX_OBSIDIAN_NOTES: usize = 5_000;
const MAX_OBSIDIAN_NOTE_BYTES: u64 = 1_500_000;
const MAX_OBSIDIAN_TOTAL_BYTES: u64 = 20_000_000;

enum ImportOutcome {
    Added,
    Updated,
    Unchanged,
}

struct ObsidianFiles {
    notes: Vec<(String, PathBuf)>,
    truncated: bool,
}

fn refresh_obsidian_vault(conn: &Connection) -> Result<String> {
    let Some(vault) = vault_dir(conn) else {
        return Err(err("Obsidian needs a vault folder before it can be refreshed."));
    };
    let ObsidianFiles { notes, truncated } = obsidian_files(&vault)?;
    let mut present = HashSet::new();
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut unreadable = 0usize;
    let mut indexed_bytes = 0u64;
    for (relative, path) in notes {
        present.insert(relative.clone());
        let Ok(metadata) = fs::metadata(&path) else {
            unreadable += 1;
            continue;
        };
        if metadata.len() > MAX_OBSIDIAN_NOTE_BYTES || indexed_bytes.saturating_add(metadata.len()) > MAX_OBSIDIAN_TOTAL_BYTES {
            unreadable += 1;
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            unreadable += 1;
            continue;
        };
        indexed_bytes = indexed_bytes.saturating_add(metadata.len());
        match import_obsidian_note(conn, &relative, &content)? {
            ImportOutcome::Added => added += 1,
            ImportOutcome::Updated => updated += 1,
            ImportOutcome::Unchanged => {}
        }
    }
    let removed = if truncated { 0 } else { reconcile_missing_obsidian_notes(conn, &present)? };
    let mut summary = format!("Obsidian vault refreshed: {added} added, {updated} updated, {removed} removed.");
    if unreadable > 0 {
        summary.push_str(&format!(" {unreadable} file{} skipped.", if unreadable == 1 { " was" } else { "s were" }));
    }
    if truncated {
        summary.push_str(&format!(" Showing the first {MAX_OBSIDIAN_NOTES} notes; no missing notes were removed."));
    }
    Ok(summary)
}

fn obsidian_files(vault: &Path) -> Result<ObsidianFiles> {
    let mut files = ObsidianFiles { notes: Vec::new(), truncated: false };
    collect_obsidian_files(vault, vault, &mut files)?;
    Ok(files)
}

fn collect_obsidian_files(vault: &Path, dir: &Path, files: &mut ObsidianFiles) -> Result<()> {
    if files.truncated {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            collect_obsidian_files(vault, &path, files)?;
            if files.truncated {
                return Ok(());
            }
            continue;
        }
        let is_markdown = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !file_type.is_file() || !is_markdown || name.starts_with('.') {
            continue;
        }
        if files.notes.len() >= MAX_OBSIDIAN_NOTES {
            files.truncated = true;
            return Ok(());
        }
        let relative = path
            .strip_prefix(vault)
            .map_err(|_| err("Obsidian note is outside the configured vault"))?
            .to_string_lossy()
            .replace('\\', "/");
        files.notes.push((relative, path));
    }
    Ok(())
}

fn import_obsidian_note(conn: &Connection, relative: &str, content: &str) -> Result<ImportOutcome> {
    let existing = existing_obsidian_item(conn, relative)?;
    let links = wikilinks(content);
    if let Some((id, _origin, sync_json, old_content)) = existing {
        let changed = old_content != content;
        if changed {
            let embedding = embed::embed(content);
            conn.execute(
                "UPDATE memory_items SET source_type=CASE WHEN engine_origin='obsidian_khoj' THEN 'obsidian_md' ELSE source_type END, content_markdown=?1, wikilinks_json=?2, content_hash=?3, updated_at=?4, external_id=CASE WHEN engine_origin='obsidian_khoj' THEN ?5 ELSE external_id END WHERE id=?6",
                params![content, serde_json::to_string(&links)?, content_hash(content), now_ms(), relative, id],
            )?;
            conn.execute(
                "INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?1,?2) ON CONFLICT(memory_id) DO UPDATE SET embedding_json=excluded.embedding_json",
                params![id, serde_json::to_string(&embedding)?],
            )?;
        }
        if !synced(&sync_json, "obsidian_khoj") {
            mark_synced(conn, &id, "obsidian_khoj", relative)?;
        }
        return Ok(if changed { ImportOutcome::Updated } else { ImportOutcome::Unchanged });
    }
    let id = nid("mem");
    let title = title_from_path(relative);
    let embedding = embed::embed(content);
    conn.execute(
        "INSERT INTO memory_items (id, source_type, scoped_bot_id, file_path_or_uri, title, content_markdown, wikilinks_json, content_hash, updated_at, engine_origin, valid_from, invalid_at, external_id, sync_json) VALUES (?1,'obsidian_md',NULL,?2,?3,?4,?5,?6,?7,'obsidian_khoj',?7,NULL,?2,'{}')",
        params![id, relative, title, content, serde_json::to_string(&links)?, content_hash(content), now_ms()],
    )?;
    conn.execute(
        "INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?1,?2)",
        params![id, serde_json::to_string(&embedding)?],
    )?;
    mark_synced(conn, &id, "obsidian_khoj", relative)?;
    Ok(ImportOutcome::Added)
}

fn existing_obsidian_item(conn: &Connection, relative: &str) -> Result<Option<(String, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, engine_origin, sync_json, content_markdown FROM memory_items WHERE file_path_or_uri=?1",
    )?;
    let rows = stmt.query_map(params![relative], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    })?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().find(|(_, origin, sync_json, _)| origin == "obsidian_khoj" || synced(sync_json, "obsidian_khoj")))
}

fn reconcile_missing_obsidian_notes(conn: &Connection, present: &HashSet<String>) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT id, engine_origin, file_path_or_uri, sync_json FROM memory_items")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    })?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut removed = 0usize;
    for (id, origin, path, sync_json) in rows {
        let normalized = path.replace('\\', "/");
        let has_obsidian_copy = origin == "obsidian_khoj" || synced(&sync_json, "obsidian_khoj");
        if !has_obsidian_copy || present.contains(&normalized) {
            continue;
        }
        if origin == "obsidian_khoj" {
            conn.execute("DELETE FROM memory_embeddings WHERE memory_id=?1", params![id])?;
            conn.execute("DELETE FROM memory_items WHERE id=?1", params![id])?;
            removed += 1;
        } else {
            unmark_synced(conn, &id, "obsidian_khoj")?;
        }
    }
    Ok(removed)
}

fn title_from_path(relative: &str) -> String {
    Path::new(relative)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Untitled note")
        .to_string()
}

fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn project_file(conn: &Connection, id: &str, content: &str, file_path: &str, engine: &str, has_obsidian_copy: bool) -> Result<Option<String>> {
    let companion = global_companion(conn)?;
    let primary = resolve_engine(conn, None).unwrap_or_else(|_| builtin_engine());
    let Some(vault) = vault_dir(conn) else {
        if companion || primary == "obsidian_khoj" {
            return Ok(Some("Vault folder is missing, so the note stayed in the Mem0 vault.".into()));
        }
        return Ok(None);
    };
    let explicit = {
        let trimmed = file_path.trim();
        !trimmed.is_empty() && !trimmed.contains("://")
    };
    if engine != "obsidian_khoj" && !has_obsidian_copy && !companion && primary != "obsidian_khoj" && !explicit {
        return Ok(None);
    }
    let rel = relative_path(id, file_path);
    match obsidian::write_note(&vault, &rel, content) {
        Ok(path) => {
            let stored_path = if explicit { file_path.trim().replace('\\', "/") } else { rel.clone() };
            conn.execute(
                "UPDATE memory_items SET file_path_or_uri=?1, external_id=CASE WHEN engine_origin='obsidian_khoj' THEN ?1 ELSE external_id END WHERE id=?2",
                params![stored_path, id],
            )?;
            mark_synced(conn, id, "obsidian_khoj", &rel)?;
            Ok(Some(format!("Wrote {}", path.display())))
        }
        Err(error) => Err(error),
    }
}

fn relative_path(id: &str, file_path: &str) -> String {
    let trimmed = file_path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        format!("ronic/{}.md", safe_id(id))
    } else {
        trimmed.replace('\\', "/")
    }
}

fn safe_id(id: &str) -> String {
    let cleaned: String = id.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' }).collect();
    if cleaned.is_empty() { "note".into() } else { cleaned }
}

fn vault_dir(conn: &Connection) -> Option<std::path::PathBuf> {
    let settings = db::settings_of(conn).ok()?;
    let path = Path::new(&settings.obsidian_vault);
    if path.is_dir() { Some(path.to_path_buf()) } else { None }
}

fn global_companion(conn: &Connection) -> Result<bool> {
    let companion: Option<String> = conn.query_row("SELECT companion_engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap_or(None);
    Ok(companion.as_deref() == Some("obsidian_khoj"))
}

fn resolve_engine(conn: &Connection, bot_id: Option<&str>) -> Result<String> {
    if let Some(bot_id) = bot_id.map(str::trim).filter(|id| !id.is_empty()) {
        if let Ok(engine) = conn.query_row("SELECT engine_id FROM memory_routes WHERE id=?1 AND scope='bot'", params![bot_id], |row| row.get::<_, String>(0)) {
            return Ok(engine);
        }
    }
    Ok(conn.query_row("SELECT engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap_or_else(|_| builtin_engine()))
}

fn resolve_requested_engine(conn: &Connection, requested: Option<&str>, bot_id: Option<&str>) -> Result<String> {
    let engine = resolve_engine(conn, bot_id)?;
    if let Some(requested) = requested.map(str::trim).filter(|id| !id.is_empty()) {
        if requested != engine {
            return Err(err("the selected memory engine does not match this scope; refresh the vault and try again"));
        }
    }
    if engine != "mem0_builtin" && engine != "obsidian_khoj" {
        return Err(err("driver not attached"));
    }
    Ok(engine)
}

fn builtin_engine() -> String {
    "mem0_builtin".into()
}

fn synced(raw: &str, engine: &str) -> bool {
    serde_json::from_str::<Value>(raw).ok().and_then(|value| value.get(engine).cloned()).is_some()
}

fn memory_in_engine(origin: &str, sync_json: &str, engine: &str) -> bool {
    origin == engine || synced(sync_json, engine)
}

fn mark_synced(conn: &Connection, id: &str, engine: &str, path: &str) -> Result<()> {
    let raw: String = conn.query_row("SELECT sync_json FROM memory_items WHERE id=?1", params![id], |row| row.get(0))?;
    let mut value: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    value[engine] = json!({"path": path, "syncedAt": now_ms()});
    conn.execute("UPDATE memory_items SET sync_json=?1 WHERE id=?2", params![value.to_string(), id])?;
    Ok(())
}

fn unmark_synced(conn: &Connection, id: &str, engine: &str) -> Result<()> {
    let raw: String = conn.query_row("SELECT sync_json FROM memory_items WHERE id=?1", params![id], |row| row.get(0))?;
    let mut value: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if let Some(entries) = value.as_object_mut() {
        entries.remove(engine);
    }
    conn.execute("UPDATE memory_items SET sync_json=?1 WHERE id=?2", params![value.to_string(), id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn temp_conn() -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(nid("ronicmem"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("state.db")).unwrap();
        db::migrate(&conn).unwrap();
        (dir, conn)
    }

    fn sample(title: &str, body: &str) -> MemoryInput {
        MemoryInput {
            id: None,
            title: title.into(),
            content_markdown: body.into(),
            source_type: "manual".into(),
            scoped_bot_id: None,
            file_path_or_uri: String::new(),
            engine_id: None,
        }
    }

    #[test]
    fn fresh_route_is_the_builtin_engine() {
        let (dir, conn) = temp_conn();
        let engine: String = conn.query_row("SELECT engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap();
        assert_eq!(engine, "mem0_builtin");
        let availability: String = conn.query_row("SELECT availability FROM memory_engines WHERE id='mem0_builtin'", [], |row| row.get(0)).unwrap();
        assert_eq!(availability, "builtin");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn older_openmemory_rows_move_into_the_mem0_vault() {
        let (dir, conn) = temp_conn();
        conn.execute(
            "INSERT INTO memory_items (id, source_type, scoped_bot_id, file_path_or_uri, title, content_markdown, wikilinks_json, content_hash, updated_at, engine_origin) VALUES ('mem_old','manual',NULL,'','Stack','Tauri','[]','5',1,'openmemory_builtin')",
            [],
        ).unwrap();
        conn.execute("UPDATE memory_routes SET engine_id='openmemory_builtin' WHERE id='global'", []).unwrap();
        db::migrate(&conn).unwrap();
        let engine: String = conn.query_row("SELECT engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap();
        let origin: String = conn.query_row("SELECT engine_origin FROM memory_items WHERE id='mem_old'", [], |row| row.get(0)).unwrap();
        let leftover: i64 = conn.query_row("SELECT COUNT(*) FROM memory_engines WHERE id IN ('openmemory_builtin','mem0_sdk')", [], |row| row.get(0)).unwrap();
        assert_eq!(engine, "mem0_builtin");
        assert_eq!(origin, "mem0_builtin");
        assert_eq!(leftover, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn scan_does_not_change_the_route() {
        let (dir, conn) = temp_conn();
        scan::apply_scan(&conn, &EngineProbe { port_8000: true, banner_8000: String::new(), letta: false, khoj: false, vaults: Vec::new() }, 4).unwrap();
        let engine: String = conn.query_row("SELECT engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap();
        assert_eq!(engine, "mem0_builtin");
        let mem0: String = conn.query_row("SELECT availability FROM memory_engines WHERE id='mem0_builtin'", [], |row| row.get(0)).unwrap();
        assert_eq!(mem0, "builtin");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remember_and_forget_keep_the_journal() {
        let (dir, conn) = temp_conn();
        let saved = remember(&conn, &sample("Preferred stack", "Use Tauri v2 and a local SQLite journal.")).unwrap();
        assert_eq!(builtin::count(&conn, "memory_items").unwrap(), 1);
        assert_eq!(builtin::count(&conn, "memory_embeddings").unwrap(), 1);
        assert_eq!(builtin::event_count(&conn, "remember").unwrap(), 1);
        let block = prompt_context(&conn, "Tauri SQLite", None);
        assert!(block.contains("Preferred stack"), "{block}");
        forget(&conn, &saved.id, None).unwrap();
        assert_eq!(builtin::count(&conn, "memory_items").unwrap(), 0);
        assert_eq!(builtin::count(&conn, "memory_embeddings").unwrap(), 0);
        assert_eq!(builtin::event_count(&conn, "forget").unwrap(), 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn obsidian_vault_can_import_edit_and_delete_notes() {
        let (dir, conn) = temp_conn();
        let vault = dir.join("vault");
        std::fs::create_dir_all(vault.join("projects")).unwrap();
        let path = vault.join("projects").join("roadmap.md");
        std::fs::write(&path, "Initial roadmap with [[Launch]].").unwrap();
        let mut settings = db::settings_of(&conn).unwrap();
        settings.obsidian_vault = vault.display().to_string();
        db::save_settings(&conn, &settings).unwrap();
        conn.execute("UPDATE memory_engines SET availability='detected' WHERE id='obsidian_khoj'", []).unwrap();

        let imported = refresh_vault(&conn, "obsidian_khoj").unwrap();
        assert!(imported.contains("1 added"), "{imported}");
        let (id, origin, file_path): (String, String, String) = conn.query_row(
            "SELECT id, engine_origin, file_path_or_uri FROM memory_items WHERE engine_origin='obsidian_khoj'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(origin, "obsidian_khoj");
        assert_eq!(file_path, "projects/roadmap.md");

        set_route(&conn, "global", "obsidian_khoj").unwrap();
        let mut edit = sample("Roadmap", "Updated roadmap with [[Release]].");
        edit.id = Some(id.clone());
        edit.source_type = "obsidian_md".into();
        edit.file_path_or_uri = file_path;
        edit.engine_id = Some("obsidian_khoj".into());
        remember(&conn, &edit).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Updated roadmap with [[Release]].");

        forget(&conn, &id, Some("obsidian_khoj")).unwrap();
        assert!(!path.exists());
        assert_eq!(builtin::count(&conn, "memory_items").unwrap(), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_engine_cannot_become_active() {
        let (dir, conn) = temp_conn();
        let error = set_route(&conn, "global", "mem0_sdk").unwrap_err();
        assert!(error.0.contains("not installed"), "{}", error.0);
        let engine: String = conn.query_row("SELECT engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap();
        assert_eq!(engine, "mem0_builtin");
        conn.execute("UPDATE memory_engines SET availability='detected' WHERE id='zep_graphiti'", []).unwrap();
        let attached = set_route(&conn, "global", "zep_graphiti").unwrap_err();
        assert!(attached.0.contains("not attached"), "{}", attached.0);
        let still: String = conn.query_row("SELECT engine_id FROM memory_routes WHERE id='global'", [], |row| row.get(0)).unwrap();
        assert_eq!(still, "mem0_builtin");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
}
