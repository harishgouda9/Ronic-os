use crate::embed::{self, cosine};
#[cfg(test)]
use crate::error::Result;
use rusqlite::{params, Connection};

pub fn prompt_block(conn: &Connection, prompt: &str, engine_id: &str, bot_id: Option<&str>) -> String {
    let query = embed::embed(prompt);
    let mut stmt = match conn.prepare("SELECT m.title, m.content_markdown, e.embedding_json FROM memory_items m JOIN memory_embeddings e ON e.memory_id = m.id WHERE (m.engine_origin=?1 OR m.sync_json LIKE ?2 ESCAPE '\\') AND (m.scoped_bot_id IS NULL OR m.scoped_bot_id=?3)") {
        Ok(stmt) => stmt,
        Err(_) => return "No memory index.".into(),
    };
    let synced_pattern = format!("%\"{}\"%", engine_id.replace('%', "\\%").replace('_', "\\_"));
    let rows = stmt.query_map(params![engine_id, synced_pattern, bot_id.unwrap_or("")], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)));
    let Ok(rows) = rows else { return "No memory index.".into() };
    let mut ranked = Vec::new();
    for row in rows.flatten() {
        let emb: Vec<f32> = serde_json::from_str(&row.2).unwrap_or_default();
        ranked.push((cosine(&query, &emb), row.0, row.1));
    }
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(3);
    if ranked.is_empty() {
        return "None indexed.".into();
    }
    ranked
        .into_iter()
        .map(|(_score, title, body)| format!("- {title}: {}", clip(&body, 180)))
        .collect::<Vec<_>>()
        .join("\n")
}

pub struct RankedNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub score: f32,
}

/// Rank saved notes with the same local embedding chat uses.
pub fn search_notes(conn: &Connection, query: &str, engine_id: &str, limit: usize) -> Vec<RankedNote> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }
    let embedded = embed::embed(query);
    let mut stmt = match conn.prepare(
        "SELECT m.id, m.title, m.content_markdown, e.embedding_json FROM memory_items m JOIN memory_embeddings e ON e.memory_id = m.id WHERE m.engine_origin=?1 OR m.sync_json LIKE ?2 ESCAPE '\\'",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let synced_pattern = format!("%\"{}\"%", engine_id.replace('%', "\\%").replace('_', "\\_"));
    let rows = stmt.query_map(params![engine_id, synced_pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    });
    let Ok(rows) = rows else { return Vec::new() };
    let mut ranked = Vec::new();
    for row in rows.flatten() {
        let emb: Vec<f32> = serde_json::from_str(&row.3).unwrap_or_default();
        ranked.push(RankedNote { id: row.0, title: row.1, content: row.2, score: cosine(&embedded, &emb) });
    }
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(limit);
    ranked
}

fn clip(text: &str, limit: usize) -> String {
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

#[cfg(test)]
pub fn count(conn: &Connection, table: &str) -> Result<i64> {
    let sql = match table {
        "memory_items" => "SELECT COUNT(*) FROM memory_items",
        "memory_embeddings" => "SELECT COUNT(*) FROM memory_embeddings",
        "memory_events" => "SELECT COUNT(*) FROM memory_events",
        _ => return Ok(0),
    };
    Ok(conn.query_row(sql, [], |row| row.get(0))?)
}

#[cfg(test)]
pub fn event_count(conn: &Connection, op: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM memory_events WHERE op=?1", params![op], |row| row.get(0))?)
}
