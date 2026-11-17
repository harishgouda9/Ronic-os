use crate::error::{err, Result};
use crate::models::CuratedEntry;
use crate::util::{nid, now_ms};
use rusqlite::{params, Connection};

const USER_LIMIT: usize = 1375;
const MEMORY_LIMIT: usize = 2200;
const BOT_LIMIT: usize = 1800;

struct Row {
    id: String,
    content: String,
}

pub fn curate(conn: &Connection, target: &str, action: &str, old_text: &str, content: &str, bot_id: Option<&str>) -> Result<String> {
    let store = store_key(target, bot_id)?;
    let action = match action.trim().to_ascii_lowercase().as_str() {
        "add" => "add",
        "replace" | "patch" => "replace",
        "remove" => "remove",
        _ => return Err(err("action is add, replace, or remove.")),
    };
    let content = content.trim();
    let old_text = old_text.trim();
    if content.contains('\n') || content.contains('\r') || old_text.contains('\n') || old_text.contains('\r') {
        return Err(err("Keep a curated fact on one line."));
    }
    if old_text.chars().count() > 2000 {
        return Err(err("That match text is too long."));
    }
    let limit = char_limit(&store);
    if content.chars().count() > limit {
        return Err(err(format!("That fact is over the {limit} character cap. Shorten it.")));
    }
    let mut rows = load(conn, &store)?;
    let label = store_label(&store);
    match action {
        "add" => add_fact(conn, &store, &mut rows, content, label, limit),
        "replace" => replace_fact(conn, &store, &mut rows, old_text, content, label, limit),
        "remove" => remove_fact(conn, &store, &mut rows, old_text, label),
        _ => unreachable!(),
    }
}

pub fn forget_curated(conn: &Connection, id: &str) -> Result<String> {
    let id = id.trim();
    if id.is_empty() {
        return Err(err("That always-on note was not found."));
    }
    let removed = conn.execute("DELETE FROM curated_entries WHERE id=?1", params![id])?;
    if removed == 0 {
        return Err(err("That always-on note was not found."));
    }
    wrote(conn, "Removed that always-on note.".into())
}

fn wrote(conn: &Connection, message: String) -> Result<String> {
    match super::sheet::publish_always(conn) {
        Ok(()) => Ok(message),
        Err(error) => Ok(format!("{message}\nAlways-on sheet was not written: {error}")),
    }
}

pub fn list_curated(conn: &Connection) -> Result<Vec<CuratedEntry>> {
    let mut stmt = conn.prepare("SELECT id, store, content FROM curated_entries ORDER BY store, updated_at, id")?;
    let rows = stmt.query_map([], |row| {
        Ok(CuratedEntry { id: row.get(0)?, store: row.get(1)?, content: row.get(2)? })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn always_document(conn: &Connection) -> Result<String> {
    let mut stmt = conn.prepare("SELECT store, content FROM curated_entries ORDER BY store, updated_at, id")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut out = String::from("---\nkind: always\n---\n");
    emit_store(&mut out, "user", "user", &rows);
    emit_store(&mut out, "memory", "memory", &rows);
    let mut bots: Vec<&str> = rows.iter().filter(|(store, _)| store.starts_with("bot:")).map(|(store, _)| store.as_str()).collect();
    bots.sort();
    bots.dedup();
    for store in bots {
        emit_store(&mut out, store, store, &rows);
    }
    Ok(out)
}

fn emit_store(out: &mut String, title: &str, store: &str, rows: &[(String, String)]) {
    let mine: Vec<&str> = rows.iter().filter(|(name, _)| name == store).map(|(_, content)| content.as_str()).collect();
    let used: usize = mine.iter().map(|content| content.chars().count()).sum();
    out.push_str(&format!("\n## {title} {used}/{}\n", char_limit(store)));
    for content in mine {
        out.push_str("- ");
        out.push_str(content);
        out.push('\n');
    }
}

/// Always-on block for the chat system prompt. Entry text is counted against
/// the cap. The header is extra, so the model can see the budget.
pub fn preface(conn: &Connection, bot_id: Option<&str>) -> String {
    let mut out = String::from(
        "Always-on notes. curate_memory stores a short fact that is included on every turn. A write over the cap is refused, so shorten or remove one first. save_memory is the longer vault and is not this list.",
    );
    push_section(conn, &mut out, "User", "user");
    push_section(conn, &mut out, "Environment", "memory");
    if let Some(id) = bot_id.map(str::trim).filter(|id| !id.is_empty()) {
        push_section(conn, &mut out, "This bot", &format!("bot:{id}"));
    }
    out
}

fn add_fact(conn: &Connection, store: &str, rows: &mut Vec<Row>, content: &str, label: &str, limit: usize) -> Result<String> {
    if content.is_empty() {
        return Err(err("curate_memory add needs content."));
    }
    if rows.iter().any(|row| row.content == content) {
        return Ok(format!("Refused. That fact is already in {label}.\n{}", gauge(store, rows)));
    }
    let next = used(rows) + content.chars().count();
    if next > limit {
        return Ok(format!("Refused. {label} would be {next}/{limit} characters. Shorten or remove a fact first.\n{}", gauge(store, rows)));
    }
    let id = nid("cur");
    conn.execute(
        "INSERT INTO curated_entries (id, store, content, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, store, content, now_ms()],
    )?;
    rows.push(Row { id, content: content.to_string() });
    wrote(conn, format!("Added one {label} fact. {}\n{}", usage(store, rows), gauge(store, rows)))
}

fn replace_fact(conn: &Connection, store: &str, rows: &mut Vec<Row>, old_text: &str, content: &str, label: &str, limit: usize) -> Result<String> {
    if old_text.is_empty() {
        return Err(err("replace needs oldText, a unique piece of the fact to change."));
    }
    if content.is_empty() {
        return Err(err("replace needs the new content."));
    }
    let hits = hits(rows, old_text);
    if hits.len() != 1 {
        return Ok(mismatch(store, rows, hits.len()));
    }
    let idx = hits[0];
    let next_body = rows[idx].content.replacen(old_text, content, 1).trim().to_string();
    if next_body.is_empty() {
        return Err(err("replace would leave an empty fact. Use remove."));
    }
    if rows.iter().enumerate().any(|(i, row)| i != idx && row.content == next_body) {
        return Ok(format!("Refused. That text is already in {label}.\n{}", gauge(store, rows)));
    }
    let next_used = used(rows) - rows[idx].content.chars().count() + next_body.chars().count();
    if next_used > limit {
        return Ok(format!("Refused. {label} would be {next_used}/{limit} characters. Shorten the fact first.\n{}", gauge(store, rows)));
    }
    conn.execute(
        "UPDATE curated_entries SET content=?1, updated_at=?2 WHERE id=?3",
        params![next_body, now_ms(), rows[idx].id],
    )?;
    rows[idx].content = next_body;
    wrote(conn, format!("Updated one {label} fact. {}\n{}", usage(store, rows), gauge(store, rows)))
}

fn remove_fact(conn: &Connection, store: &str, rows: &mut Vec<Row>, old_text: &str, label: &str) -> Result<String> {
    if old_text.is_empty() {
        return Err(err("remove needs oldText, a unique piece of the fact to delete."));
    }
    let hits = hits(rows, old_text);
    if hits.len() != 1 {
        return Ok(mismatch(store, rows, hits.len()));
    }
    let idx = hits[0];
    conn.execute("DELETE FROM curated_entries WHERE id=?1", params![rows[idx].id])?;
    rows.remove(idx);
    wrote(conn, format!("Removed one {label} fact. {}\n{}", usage(store, rows), gauge(store, rows)))
}

fn store_key(target: &str, bot_id: Option<&str>) -> Result<String> {
    match target.trim().to_ascii_lowercase().as_str() {
        "user" => Ok("user".into()),
        "memory" | "environment" => Ok("memory".into()),
        "bot" => {
            let id = bot_id.unwrap_or("").trim();
            if id.is_empty() {
                Err(err("Bot notes need a bot profile."))
            } else {
                Ok(format!("bot:{id}"))
            }
        }
        _ => Err(err("target is user, memory, or bot.")),
    }
}

fn char_limit(store: &str) -> usize {
    match store {
        "user" => USER_LIMIT,
        "memory" => MEMORY_LIMIT,
        _ => BOT_LIMIT,
    }
}

fn store_label(store: &str) -> &'static str {
    match store {
        "user" => "user",
        "memory" => "environment",
        _ => "bot",
    }
}

fn load(conn: &Connection, store: &str) -> Result<Vec<Row>> {
    let mut stmt = conn.prepare("SELECT id, content FROM curated_entries WHERE store=?1 ORDER BY updated_at, id")?;
    let rows = stmt.query_map(params![store], |row| Ok(Row { id: row.get(0)?, content: row.get(1)? }))?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
}

fn used(rows: &[Row]) -> usize {
    rows.iter().map(|row| row.content.chars().count()).sum()
}

fn hits(rows: &[Row], needle: &str) -> Vec<usize> {
    rows.iter().enumerate().filter(|(_, row)| row.content.contains(needle)).map(|(index, _)| index).collect()
}

fn usage(store: &str, rows: &[Row]) -> String {
    format!("{} {}/{} characters", store_label(store), used(rows), char_limit(store))
}

fn gauge(store: &str, rows: &[Row]) -> String {
    if rows.is_empty() {
        return format!("{} [0/{}]: (none)", section_name(store), char_limit(store));
    }
    let mut out = format!("{} [{}/{}]:", section_name(store), used(rows), char_limit(store));
    for row in rows {
        out.push_str("\n- ");
        out.push_str(&row.content);
    }
    out
}

fn section_name(store: &str) -> &'static str {
    match store {
        "user" => "User",
        "memory" => "Environment",
        _ => "This bot",
    }
}

fn mismatch(store: &str, rows: &[Row], count: usize) -> String {
    format!("Refused. That text matched {count} facts. Pass a longer unique piece of the one fact to change.\n{}", gauge(store, rows))
}

fn push_section(conn: &Connection, out: &mut String, title: &str, store: &str) {
    out.push('\n');
    match load(conn, store) {
        Ok(rows) if rows.is_empty() => out.push_str(&format!("{title} [0/{}]: (none)", char_limit(store))),
        Ok(rows) => {
            out.push_str(&format!("{title} [{}/{}]:", used(&rows), char_limit(store)));
            for row in rows {
                out.push_str("\n- ");
                out.push_str(&row.content);
            }
        }
        Err(_) => out.push_str(&format!("{title}: unavailable")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::memory::prompt_context;

    fn temp_conn() -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(nid("roniccur"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("state.db")).unwrap();
        db::migrate(&conn).unwrap();
        (dir, conn)
    }

    #[test]
    fn curated_facts_stay_in_the_prompt_and_off_the_vault() {
        let (dir, conn) = temp_conn();
        conn.execute(
            "INSERT INTO memory_items (id, source_type, scoped_bot_id, file_path_or_uri, title, content_markdown, wikilinks_json, content_hash, updated_at, engine_origin) VALUES ('mem_keep','manual',NULL,'','Vault note','Leave this row alone.','[]','1',1,'mem0_builtin')",
            [],
        )
        .unwrap();

        let added = curate(&conn, "user", "add", "", "Prefers one-line answers.", None).unwrap();
        assert!(added.starts_with("Added one user fact."), "{added}");
        let again = curate(&conn, "user", "add", "", "Prefers one-line answers.", None).unwrap();
        assert!(again.starts_with("Refused."), "{again}");
        assert_eq!(conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM curated_entries", [], |row| row.get(0)).unwrap(), 1);

        let wide = "x".repeat(MEMORY_LIMIT);
        curate(&conn, "memory", "add", "", &wide, None).unwrap();
        let overflow = curate(&conn, "memory", "add", "", "y", None).unwrap();
        assert!(overflow.starts_with("Refused."), "{overflow}");
        let memory_rows: i64 = conn.query_row("SELECT COUNT(*) FROM curated_entries WHERE store='memory'", [], |row| row.get(0)).unwrap();
        assert_eq!(memory_rows, 1);

        curate(&conn, "user", "add", "", "Also likes Rust.", None).unwrap();
        let ambiguous = curate(&conn, "user", "replace", "e", "x", None).unwrap();
        assert!(ambiguous.contains("matched 2"), "{ambiguous}");
        let updated = curate(&conn, "user", "replace", "one-line", "short", None).unwrap();
        assert!(updated.starts_with("Updated one user fact."), "{updated}");
        let body: String = conn.query_row("SELECT content FROM curated_entries WHERE store='user' AND content LIKE '%short%'", [], |row| row.get(0)).unwrap();
        assert_eq!(body, "Prefers short answers.");

        curate(&conn, "bot", "add", "", "This bot checks the vault first.", Some("bot_a")).unwrap();
        let own = prompt_context(&conn, "anything", Some("bot_a"));
        assert!(own.contains("Prefers short answers."), "{own}");
        assert!(own.contains("This bot checks the vault first."), "{own}");
        assert!(own.contains("Vault notes:"), "{own}");
        let other = prompt_context(&conn, "anything", Some("bot_b"));
        assert!(!other.contains("This bot checks the vault first."), "{other}");
        assert!(other.contains("Prefers short answers."), "{other}");

        curate(&conn, "bot", "remove", "vault first", "", Some("bot_a")).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM curated_entries WHERE store='bot:bot_a'", [], |row| row.get(0)).unwrap();
        assert_eq!(left, 0);
        let vault: String = conn.query_row("SELECT content_markdown FROM memory_items WHERE id='mem_keep'", [], |row| row.get(0)).unwrap();
        assert_eq!(vault, "Leave this row alone.");

        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
}
