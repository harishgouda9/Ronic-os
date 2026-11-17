//! Direct web research: discover sources, read them, then let the bot's own model
//! synthesize the answer. No pasted prompts, Perplexity key, or browser login.

use crate::AppState;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

#[derive(Clone, Debug)]
struct Source {
    title: String,
    url: String,
    snippet: String,
    published: String,
    publisher: String,
    discovery: String,
}

#[derive(Default)]
struct Bundle {
    sources: Vec<Source>,
    evidence: Vec<(Source, String)>,
    failures: Vec<String>,
    queries: Vec<String>,
}

/// Discover and read sources in one call. The model receives evidence, not an
/// external model's finished answer, and remains responsible for the summary.
pub fn search(_state: &AppState, args: &Value) -> (String, Value, String) {
    let query = args.get("query").or_else(|| args.get("q")).and_then(Value::as_str).unwrap_or("").trim();
    if query.is_empty() {
        return fail("web_search needs a query.");
    }
    let count = args.get("count").and_then(Value::as_i64).unwrap_or(10).clamp(1, 20) as usize;
    let current = is_current_query(query);
    let mut bundle = Bundle::default();
    discover(query, current, count, &mut bundle);
    if bundle.sources.is_empty() {
        let detail = bundle.failures.join("; ");
        return fail(format!("web_search found no readable sources for `{query}`. {detail}. Try a shorter query or inspect_page for a specific interactive source."));
    }

    // Read full pages, not just snippets. Independent HTTP fetches run in parallel;
    // the bounded source count and per-request timeout keep the tool predictable.
    let candidates: Vec<Source> = bundle
        .sources
        .iter()
        .filter(|source| !is_aggregator(&source.url))
        .take(count.min(8))
        .cloned()
        .collect();
    let reads: Vec<(Source, Result<String, String>)> = std::thread::scope(|scope| {
        let jobs: Vec<_> = candidates
            .into_iter()
            .map(|source| {
                scope.spawn(move || {
                    let result = fetch_page(&source.url, 8_000).map(|page| page.text);
                    (source, result)
                })
            })
            .collect();
        jobs.into_iter().map(|job| job.join().unwrap_or_else(|_| (Source::default(), Err("article reader stopped".into())))).collect()
    });
    for (source, result) in reads {
        match result {
            Ok(text) if text.len() >= 180 => bundle.evidence.push((source, text)),
            Ok(_) => bundle.failures.push(format!("{} had too little readable text", source.url)),
            Err(error) => bundle.failures.push(format!("{}: {error}", source.url)),
        }
    }

    let selected: Vec<Source> = if bundle.evidence.is_empty() {
        bundle.sources.iter().take(count).cloned().collect()
    } else {
        bundle.evidence.iter().map(|(source, _)| source.clone()).collect()
    };
    let text = research_brief(query, &bundle, &selected, count);
    let payload = json!({
        "query": query,
        "sources": selected.iter().map(source_json).collect::<Vec<_>>(),
        "articlesRead": bundle.evidence.len(),
        "requiresSynthesis": true,
    });
    ("web_search".into(), payload, text)
}

impl Default for Source {
    fn default() -> Self {
        Self { title: String::new(), url: String::new(), snippet: String::new(), published: String::new(), publisher: String::new(), discovery: String::new() }
    }
}

fn source_json(source: &Source) -> Value {
    json!({"title": source.title, "url": source.url, "published": source.published, "publisher": source.publisher})
}

fn research_brief(query: &str, bundle: &Bundle, selected: &[Source], count: usize) -> String {
    let mut out = format!(
        "RESEARCH EVIDENCE — not a finished answer\nRequest: {query}\nDiscovered {} unique sources; read {} article(s) directly.\n\n",
        bundle.sources.len(),
        bundle.evidence.len()
    );
    if !bundle.evidence.is_empty() {
        out.push_str("DIRECT ARTICLE EVIDENCE (each excerpt is capped; do not invent beyond it):\n");
        for (index, (source, evidence)) in bundle.evidence.iter().enumerate() {
            out.push_str(&format!("\n[S{}] {}\nPublisher: {} | Published: {} | URL: {}\n{}\n", index + 1, source.title, display_publisher(source), display_date(source), source.url, evidence));
        }
    }
    out.push_str("\nDISCOVERED SOURCES (snippets are leads, not verified full-article facts):\n");
    for (index, source) in selected.iter().enumerate() {
        out.push_str(&format!("[D{}] {} | {} | {} | {}\n{}\n", index + 1, source.title, display_publisher(source), display_date(source), source.url, source.snippet));
    }
    out.push_str(&format!(
        "\nBOT SYNTHESIS CONTRACT — YOU MUST DO THIS NOW:\n\
         1. Independently analyze and synthesize the evidence; do not quote this instruction or just replay snippets.\n\
         2. Satisfy the user's exact request and requested quantity (up to {count}); merge duplicates and distinguish distinct developments.\n\
         3. For each item, explain what happened and why it matters concisely. Attach its date and source as a Markdown link.\n\
         4. Prefer direct article evidence over snippets. When sources conflict, say so. Do not invent dates, metrics, quotes, or facts.\n\
         5. Rank by relevance, recency, and importance; 'trending' must not be presented as measured engagement unless the evidence actually measures it.\n\
         6. If direct evidence is insufficient, say exactly what is limited, use only well-supported facts, and optionally web_fetch one missing source. Do not stop merely because a social site requires login.\n\
         7. For an X/Twitter trend request without direct X evidence, label results 'AI news being discussed now', not verified X trending data.\n"
    ));
    if !bundle.failures.is_empty() {
        out.push_str("\nCollection notes (use only if relevant to coverage):\n");
        out.push_str(&bundle.failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
    }
    out
}

fn discover(query: &str, current: bool, count: usize, bundle: &mut Bundle) {
    let news_query = if current && !query.to_ascii_lowercase().contains("when:") { format!("{query} when:7d") } else { query.to_string() };
    let encoded = form_value(&news_query);
    let google = format!("https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US%3Aen");
    let bing_query = if current { format!("{query} latest news") } else { query.to_string() };
    let bing = format!("https://www.bing.com/search?q={}&format=rss", form_value(&bing_query));
    let google_items = fetch_rss(&google, "Google News");
    let bing_items = fetch_rss(&bing, "Bing");
    bundle.queries.push(news_query);
    bundle.queries.push(bing_query);
    for (mut items, engine) in [(google_items, "Google News"), (bing_items, "Bing")] {
        match &mut items {
            Ok(found) => {
                for item in found {
                    item.discovery = engine.into();
                    add_source(bundle, item.clone());
                }
            }
            Err(error) => bundle.failures.push(format!("{engine}: {error}")),
        }
    }

    // If a constrained topic returns too little, broaden once automatically.
    if bundle.sources.len() < count.min(4) {
        let broad = broaden_query(query);
        if broad != query {
            let url = format!("https://www.bing.com/search?q={}&format=rss", form_value(&broad));
            match fetch_rss(&url, "Bing broadened") {
                Ok(items) => {
                    bundle.queries.push(broad);
                    for mut item in items {
                        item.discovery = "Bing broadened".into();
                        add_source(bundle, item);
                    }
                }
                Err(error) => bundle.failures.push(format!("Bing broadened: {error}")),
            }
        }
    }
}

fn fetch_rss(url: &str, engine: &str) -> Result<Vec<Source>, String> {
    let body = get(url, 600_000, 15)?;
    let items = parse_feed(&body, engine)?;
    if items.is_empty() { Err("feed returned no results".into()) } else { Ok(items) }
}

/// Minimal RSS/Atom item extractor. Hand-rolled so entity decoding happens
/// exactly once under our control: feed <description> often holds HTML that is
/// XML-escaped, and a generic XML tokenizer mangles it into tag fragments.
fn parse_feed(xml: &str, engine: &str) -> Result<Vec<Source>, String> {
    let mut sources = Vec::new();
    for block in item_blocks(xml) {
        let mut source = Source { discovery: engine.into(), ..Source::default() };
        if let Some(title) = field_text(&block, "title") { set_title(&mut source, &title, engine); }
        if source.url.is_empty() {
            source.url = field_text(&block, "link")
                .filter(|l| l.starts_with("http"))
                .or_else(|| atom_link(&block))
                .unwrap_or_default();
        }
        if source.url.is_empty() {
            if let Some(guid) = field_text(&block, "guid") { if guid.starts_with("http") { source.url = guid; } }
        }
        let desc = field_text(&block, "description").or_else(|| field_text(&block, "summary")).or_else(|| field_text(&block, "content")).unwrap_or_default();
        source.snippet = readable_text(&desc).chars().take(700).collect();
        source.published = ["pubDate", "published", "updated", "date"].iter().find_map(|tag| field_text(&block, tag)).unwrap_or_default();
        if !source.title.is_empty() && source.url.starts_with("http") { sources.push(source); }
    }
    Ok(sources)
}

/// Split the feed into raw <item>…</item> / <entry>…</entry> blocks.
fn item_blocks(xml: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    for tag in ["item", "entry"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let mut rest = xml;
        while let Some(start) = rest.find(&open) {
            // Make sure it is the element, not e.g. <itemfoo>.
            let after_open = &rest[start + open.len()..];
            if !after_open.starts_with('>') && !after_open.starts_with(' ') && !after_open.starts_with('\n') && !after_open.starts_with('\r') && !after_open.starts_with('\t') {
                rest = after_open;
                continue;
            }
            if let Some(end) = rest.find(&close) {
                blocks.push(rest[start..end + close.len()].to_string());
                rest = &rest[end + close.len()..];
            } else { break; }
        }
        if !blocks.is_empty() { break; }
    }
    blocks
}

/// Raw inner text of <tag>…</tag> (or <tag …>…</tag>), CDATA unwrapped, entities
/// decoded once. Returns None when the element is absent.
fn field_text(block: &str, tag: &str) -> Option<String> {
    let lower = block.to_ascii_lowercase();
    let open = format!("<{}", tag.to_ascii_lowercase());
    let start = lower.find(&open)?;
    let after_open = &block[start + open.len()..];
    let first = after_open.chars().next()?;
    if first != '>' && first != ' ' && first != '\n' && first != '\r' && first != '\t' && first != '/' {
        return None;
    }
    let gt = after_open.find('>')?;
    // Self-closing <link …/> has no inner text.
    if after_open[..gt].trim_end().ends_with('/') { return Some(String::new()); }
    let content_start = start + open.len() + gt + 1;
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let end = lower[content_start..].find(&close)? + content_start;
    let raw = &block[content_start..end];
    let unwrapped = raw.trim().trim_start_matches("<![CDATA[").trim_end_matches("]]>").trim();
    Some(decode_entities(unwrapped))
}

/// Atom <link href="…"/> carries the URL in an attribute, not inner text.
fn atom_link(block: &str) -> Option<String> {
    let lower = block.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(pos) = rest.find("<link") {
        let seg = &block[pos..];
        let gt = seg.find('>')?;
        let tag = &seg[..=gt];
        // Prefer rel="alternate" or no rel (the article), skip rel="self".
        if !tag.contains("rel=\"self\"") {
            if let Some(href) = attr(tag, "href") { if href.starts_with("http") { return Some(decode_entities(&href)); } }
        }
        rest = &rest[pos + 5..];
    }
    None
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=\"");
    let start = lower.find(&key)? + key.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn set_title(source: &mut Source, raw: &str, engine: &str) {
    if engine == "Google News" {
        // Raw title is "Story - Publisher". Capture both once.
        if let Some((head, publisher)) = raw.rsplit_once(" - ") {
            source.publisher = publisher.trim().to_string();
            source.title = head.trim().to_string();
            return;
        }
    }
    source.title = raw.trim().to_string();
}

fn add_source(bundle: &mut Bundle, source: Source) {
    let key = dedupe_key(&source.title);
    if key.len() < 8 || bundle.sources.iter().any(|existing| dedupe_key(&existing.title) == key || existing.url == source.url) { return; }
    bundle.sources.push(source);
}

fn dedupe_key(title: &str) -> String {
    title.to_ascii_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

fn is_current_query(query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    ["today", "latest", "current", "news", "trending", "recent", "this week", "now"].iter().any(|term| lower.contains(term))
}

fn broaden_query(query: &str) -> String {
    query.replace("twitter", "").replace("X/Twitter", "").replace("today's", "").replace("today", "").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_aggregator(url: &str) -> bool {
    Url::parse(url).ok().and_then(|url| url.host_str().map(str::to_ascii_lowercase)).is_some_and(|host| host == "news.google.com")
}

fn display_publisher(source: &Source) -> &str {
    if source.publisher.is_empty() { &source.discovery } else { &source.publisher }
}

fn display_date(source: &Source) -> &str {
    if source.published.is_empty() { "date not supplied" } else { &source.published }
}

struct Page {
    text: String,
}

fn fetch_page(url: &str, max_chars: usize) -> Result<Page, String> {
    let body = get(url, 1_500_000, 20)?;
    let text = readable_text(&body);
    if text.trim().is_empty() { return Err("HTTP succeeded but no readable text; page may require JavaScript".into()); }
    let mut clipped = text;
    crate::util::truncate_utf8(&mut clipped, max_chars);
    Ok(Page { text: clipped })
}

fn get(url: &str, max_bytes: usize, seconds: u64) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| "use an http or https URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err("use an http or https URL".into()); }
    if crate::computer::inspect_target_blocked(&parsed) { return Err("that host cannot be fetched".into()); }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(seconds))
        .user_agent("Mozilla/5.0 (compatible; RonicResearch/1.0)")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if crate::computer::inspect_target_blocked(attempt.url()) { attempt.error("that host cannot be fetched") }
            else if attempt.previous().len() > 5 { attempt.error("too many redirects") }
            else { attempt.follow() }
        }))
        .build()
        .map_err(|e| e.without_url().to_string())?;
    let response = client.get(parsed.as_str()).send().map_err(|e| format!("fetch failed: {}", e.without_url()))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {}", status.as_u16())); }
    let bytes = response.bytes().map_err(|e| e.without_url().to_string())?;
    let slice = &bytes[..bytes.len().min(max_bytes)];
    Ok(String::from_utf8_lossy(slice).into_owned())
}

/// Fetch one URL for follow-up reading. For complete research, web_search already
/// performs discovery and multi-source article reads in a single call.
pub fn fetch(_state: &AppState, args: &Value) -> (String, Value, String) {
    let url = args.get("url").and_then(Value::as_str).unwrap_or("").trim();
    if url.is_empty() { return fail("web_fetch needs an http or https URL."); }
    let max = args.get("max_chars").and_then(Value::as_i64).unwrap_or(10_000).clamp(500, 20_000) as usize;
    match fetch_page(url, max) {
        Ok(page) => ("web_fetch".into(), json!({"url": url}), format!("Fetched {url}:\n\n{}", page.text)),
        Err(error) => fail(format!("web_fetch could not read {url}: {error}. If it needs interaction, use inspect_page instead.")),
    }
}

fn fail(text: impl Into<String>) -> (String, Value, String) {
    ("message".into(), json!({"failed": true}), text.into())
}

fn form_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn decode_entities(value: &str) -> String {
    value.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&nbsp;", " ")
}

/// Strip markup to readable text. The bot's model does the actual analysis.
fn readable_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut skip_depth = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let rest = &html[i + 1..];
            if rest.starts_with("!--") {
                if let Some(end) = rest.find("-->") { i += 1 + end + 3; continue; }
            }
            let tag = rest.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '>' || c == '/').next().unwrap_or("").to_ascii_lowercase();
            if matches!(tag.as_str(), "script" | "style" | "noscript" | "svg" | "template" | "nav" | "footer") {
                if rest.starts_with('/') { skip_depth = skip_depth.saturating_sub(1); } else { skip_depth += 1; }
            }
            if skip_depth == 0 && matches!(tag.as_str(), "p" | "div" | "br" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "section" | "article") { out.push('\n'); }
            if let Some(end) = rest.find('>') { i += 1 + end + 1; } else { break; }
            continue;
        }
        if skip_depth == 0 {
            let ch = html[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
        } else { i += 1; }
    }
    let decoded = decode_entities(&out);
    let mut lines = Vec::new();
    let mut previous_blank = false;
    for line in decoded.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            if previous_blank { continue; }
            previous_blank = true;
        } else { previous_blank = false; }
        lines.push(trimmed);
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_scripts_and_tags() {
        let text = readable_text("<style>bad</style><h1>Title</h1><p>Hello &amp; welcome.</p><script>bad</script>");
        assert_eq!(text.replace("\n\n", "\n"), "Title\nHello & welcome.");
    }

    #[test]
    fn decodes_escaped_html_description_once() {
        // A generic XML tokenizer turns this into "p…amp;…/p" fragments; our
        // hand-rolled field reader must decode it exactly once.
        let xml = r#"<rss><channel><item><title>Story - Site</title><link>https://example.com/a</link><description>&lt;p&gt;What &amp;amp; why&lt;/p&gt;</description><pubDate>Tue, 17 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>"#;
        let results = parse_feed(xml, "Google News").unwrap();
        assert_eq!(results[0].snippet, "What & why");
        assert_eq!(results[0].published, "Tue, 17 Nov 2026 12:00:00 GMT");
        assert_eq!(results[0].publisher, "Site");
    }

    #[test]
    fn reads_atom_href_link_and_cdata() {
        let atom = r#"<feed><entry><title>Atom story</title><link href="https://ex.com/a"/><summary><![CDATA[<p>Body &amp; text</p>]]></summary><updated>2026-11-17</updated></entry></feed>"#;
        let results = parse_feed(atom, "Bing").unwrap();
        assert_eq!(results[0].url, "https://ex.com/a");
        assert_eq!(results[0].snippet, "Body & text");
        assert_eq!(results[0].published, "2026-11-17");
    }

    #[test]
    fn parses_direct_feed_results_without_an_answer_model() {
        let xml = r#"<rss><channel><item><title>Model ships - Example News</title><link>https://example.com/story</link><description>&lt;p&gt;What &amp;amp; why&lt;/p&gt;</description><pubDate>Tue, 17 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>"#;
        let results = parse_feed(xml, "Google News").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Model ships");
        assert_eq!(results[0].publisher, "Example News");
        assert_eq!(results[0].url, "https://example.com/story");
        assert_eq!(results[0].snippet, "What & why");
    }

    #[test]
    fn discovers_and_deduplicates_without_external_summary() {
        let mut bundle = Bundle::default();
        let source = Source { title: "Same story - Site".into(), url: "https://example.com/a".into(), ..Source::default() };
        add_source(&mut bundle, source.clone());
        add_source(&mut bundle, source);
        assert_eq!(bundle.sources.len(), 1);
    }

    #[test]
    fn evidence_requires_bot_synthesis_and_links() {
        let source = Source { title: "A real story".into(), url: "https://example.com/a".into(), published: "today".into(), ..Source::default() };
        let mut bundle = Bundle::default();
        bundle.sources.push(source.clone());
        bundle.evidence.push((source.clone(), "Verified article evidence.".into()));
        let brief = research_brief("AI news", &bundle, &[source], 10);
        assert!(brief.contains("BOT SYNTHESIS CONTRACT"));
        assert!(brief.contains("not a finished answer"));
        assert!(brief.contains("Verified article evidence."));
        assert!(!brief.contains("Perplexity"));
    }
}
