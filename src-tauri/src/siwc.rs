//! Official Sign in with ChatGPT for this local app.
//! Tokens come from OpenAI's OAuth server. The chatgpt.com page is never read.

use crate::error::{err, Result};
use crate::util::now_ms;
use crate::AppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
#[cfg(not(windows))]
use std::process::Command;
use std::time::{Duration, Instant};

const PROVIDER: &str = "prov_chatgpt";
const PREFIX: &str = "siwc1:";
const AUTH: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const AGENT: &str = "Ronic OS";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";

pub struct PlanTurn {
    pub instructions: String,
    pub input: Vec<(String, String)>,
}

pub fn is_plan_secret(secret: &str) -> bool {
    parse(secret).is_some_and(|row| has_plan(&row))
}

pub fn plan_bearer(secret: &str) -> Option<String> {
    let row = parse(secret)?;
    if !has_plan(&row) {
        return None;
    }
    row["access_token"].as_str().map(str::trim).filter(|token| !token.is_empty()).map(str::to_string)
}

pub fn refresh_chatgpt(state: &AppState) -> Result<()> {
    let Some(row) = ({
        let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
        secrets.get(PROVIDER).cloned().and_then(|raw| parse(&raw))
    }) else {
        return Ok(());
    };
    if !has_plan(&row) || !due(&row) {
        return Ok(());
    }
    let client_id = text(&row, "client_id");
    let refresh = text(&row, "refresh_token");
    if client_id.is_empty() || refresh.is_empty() {
        return Err(err("ChatGPT sign-in expired. Continue with ChatGPT again."));
    }
    let next = exchange_refresh(&client_id, &refresh)?;
    store(state, &next, true)
}

pub fn fresh_bearer(state: &AppState) -> Result<String> {
    refresh_chatgpt(state)?;
    let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
    let raw = secrets.get(PROVIDER).cloned().unwrap_or_default();
    plan_bearer(&raw).ok_or_else(|| err("ChatGPT is not signed in for this chat."))
}

pub fn fetch_models(token: &str) -> std::result::Result<Vec<(String, String)>, String> {
    let (status, raw) = crate::agent::http_call(crate::agent::HttpJob {
        method: "GET",
        url: "https://api.openai.com/v1/models".into(),
        bearer: Some(token.to_string()),
        headers: Vec::new(),
        json_body: None,
        form: None,
        limit: Duration::from_secs(20),
        cancel_on_refresh: false,
    })?;
    let body: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    if !(200..300).contains(&status) {
        return Err(api_error(status, &body));
    }
    let rows = body["models"].as_array().or_else(|| body["data"].as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for item in rows {
        if item.get("visibility").and_then(|value| value.as_str()) != Some("list") && item.get("visibility").is_some() {
            continue;
        }
        let slug = item["slug"].as_str().or_else(|| item["id"].as_str()).unwrap_or("").trim();
        if slug.is_empty() {
            continue;
        }
        let display = item["display_name"].as_str().or_else(|| item["name"].as_str()).unwrap_or(slug).trim();
        out.push((slug.to_string(), if display.is_empty() { slug.to_string() } else { display.to_string() }));
    }
    Ok(out)
}

pub fn complete_text(token: &str, model: &str, turn: &PlanTurn, budget: u32, limit: Duration) -> std::result::Result<String, String> {
    if turn.input.is_empty() {
        return Err("nothing to send".into());
    }
    let input: Vec<Value> = turn.input.iter().map(|(role, content)| json!({"role": role, "content": content})).collect();
    let mut body = json!({"model": model, "input": input, "store": false, "stream": true, "max_output_tokens": budget.max(128)});
    if !turn.instructions.trim().is_empty() {
        body["instructions"] = json!(turn.instructions);
    }
    let (status, text) = crate::agent::http_call(crate::agent::HttpJob {
        method: "POST",
        url: "https://api.openai.com/v1/responses".into(),
        bearer: Some(token.to_string()),
        headers: Vec::new(),
        json_body: Some(body),
        form: None,
        limit,
        cancel_on_refresh: true,
    })?;
    if !(200..300).contains(&status) {
        let body: Value = serde_json::from_str(&text).unwrap_or(json!({}));
        return Err(api_error(status, &body));
    }
    parse_sse(&text)
}

pub fn authorize(existing: Option<Value>) -> Result<(Value, String)> {
    let host = host_id()?;
    let client_id = existing.as_ref().map(|row| text(row, "client_id")).filter(|id| !id.is_empty()).or_else(saved_client);
    let id_hint = existing.as_ref().map(|row| text(row, "id_token")).filter(|id| !id.is_empty());
    let pending = begin(&host, client_id.as_deref(), id_hint.as_deref())?;
    let callback = wait_callback(&pending.listener)?;
    let granted = finish_callback(&pending, &callback)?;
    if !granted.scopes.iter().any(|scope| scope == PLAN_SCOPE) {
        let _ = std::fs::write(client_path(), &granted.client_id);
        return Err(err("ChatGPT signed you in, but plan use was not allowed. Continue with ChatGPT again and allow Ronic OS to use your plan."));
    }
    let row = json!({
        "client_id": granted.client_id,
        "access_token": granted.access_token,
        "refresh_token": granted.refresh_token,
        "id_token": granted.id_token,
        "email": granted.email,
        "expires_at": now_ms() + granted.expires_in * 1000,
        "scopes": granted.scopes,
    });
    let _ = std::fs::write(client_path(), &granted.client_id);
    let who = if granted.email.is_empty() { "your ChatGPT plan".to_string() } else { granted.email };
    Ok((row, format!("Signed in with ChatGPT as {who}. Its models are in this list.")))
}

pub fn store_plan(state: &AppState, row: &Value) -> Result<()> {
    store(state, row, true)
}

struct Pending {
    listener: TcpListener,
    redirect: String,
    verifier: String,
    state: String,
    nonce: String,
    client_id: String,
    fresh: bool,
}

struct Granted {
    client_id: String,
    access_token: String,
    refresh_token: String,
    id_token: String,
    email: String,
    expires_in: i64,
    scopes: Vec<String>,
}

fn begin(host: &str, client_id: Option<&str>, id_hint: Option<&str>) -> Result<Pending> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| err(error.to_string()))?;
    let port = listener.local_addr().map_err(|error| err(error.to_string()))?.port();
    let redirect = format!("http://127.0.0.1:{port}/auth/callback");
    let verifier = random_token(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(24)?;
    let nonce = random_token(24)?;
    let fresh = client_id.is_none();
    let client = client_id.unwrap_or("dynamic_agent_client");
    let mut url = format!(
        "{AUTH}?client_id={}&response_type=code&redirect_uri={}&scope={}&resource={}&state={}&nonce={}&code_challenge_method=S256&code_challenge={}&ext_agent_host_id={}",
        encode(client),
        encode(&redirect),
        encode(SCOPE),
        encode(RESOURCE),
        encode(&state),
        encode(&nonce),
        encode(&challenge),
        encode(host),
    );
    if fresh {
        url.push_str("&agent_name_hint=");
        url.push_str(&encode(AGENT));
    }
    if let Some(hint) = id_hint {
        url.push_str("&id_token_hint=");
        url.push_str(&encode(hint));
    }
    open_browser(&url)?;
    Ok(Pending { listener, redirect, verifier, state, nonce, client_id: client.to_string(), fresh })
}

fn finish_callback(pending: &Pending, request_line: &str) -> Result<Granted> {
    let query = request_line.split_whitespace().nth(1).unwrap_or("");
    let query = query.split_once('?').map(|(_, query)| query).unwrap_or("");
    let params = query_map(query);
    if params.get("state").map(String::as_str) != Some(pending.state.as_str()) {
        return Err(err("ChatGPT returned a sign-in that did not match this attempt."));
    }
    if let Some(error) = params.get("error") {
        if error == "access_denied" {
            return Err(err("ChatGPT sign-in was cancelled."));
        }
        return Err(err(format!("ChatGPT sign-in failed ({error}).")));
    }
    let code = params.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        return Err(err("ChatGPT did not return a sign-in code."));
    }
    let issued = params.get("client_id").cloned().filter(|id| !id.is_empty() && id != "dynamic_agent_client");
    let client_id = if pending.fresh {
        issued.ok_or_else(|| err("ChatGPT did not finish registering this app."))?
    } else if let Some(issued) = issued {
        if issued != pending.client_id {
            return Err(err("ChatGPT returned a different app registration."));
        }
        issued
    } else {
        pending.client_id.clone()
    };
    let body = form_post(TOKEN, &[
        ("grant_type", "authorization_code"),
        ("client_id", &client_id),
        ("code", &code),
        ("code_verifier", &pending.verifier),
        ("redirect_uri", &pending.redirect),
        ("resource", RESOURCE),
    ])?;
    granted_from(&body, &client_id, &pending.nonce)
}

fn exchange_refresh(client_id: &str, refresh: &str) -> Result<Value> {
    let body = form_post(TOKEN, &[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh),
        ("resource", RESOURCE),
    ])?;
    let scopes = scopes_of(&body);
    if !scopes.iter().any(|scope| scope == PLAN_SCOPE) {
        return Err(err("ChatGPT plan use is no longer allowed. Continue with ChatGPT again."));
    }
    let access = text(&body, "access_token");
    let next_refresh = text(&body, "refresh_token");
    if access.is_empty() || next_refresh.is_empty() {
        return Err(err("ChatGPT did not refresh the sign-in."));
    }
    let expires = body["expires_in"].as_i64().unwrap_or(3600);
    Ok(json!({
        "client_id": client_id,
        "access_token": access,
        "refresh_token": next_refresh,
        "id_token": text(&body, "id_token"),
        "email": "",
        "expires_at": now_ms() + expires * 1000,
        "scopes": scopes,
    }))
}

fn granted_from(body: &Value, client_id: &str, nonce: &str) -> Result<Granted> {
    let access_token = text(body, "access_token");
    let refresh_token = text(body, "refresh_token");
    let id_token = text(body, "id_token");
    if access_token.is_empty() || refresh_token.is_empty() || id_token.is_empty() {
        return Err(err("ChatGPT did not return a usable sign-in."));
    }
    let claims = id_claims(&id_token)?;
    if claims["iss"].as_str() != Some("https://auth.openai.com") {
        return Err(err("ChatGPT returned an unexpected identity token."));
    }
    if !audience_matches(&claims["aud"], client_id) {
        return Err(err("ChatGPT identity token was not for this app."));
    }
    if claims["nonce"].as_str() != Some(nonce) {
        return Err(err("ChatGPT identity token did not match this sign-in."));
    }
    let exp = claims["exp"].as_i64().unwrap_or(0);
    if exp > 0 && exp * 1000 < now_ms() - 60_000 {
        return Err(err("ChatGPT identity token had already expired."));
    }
    Ok(Granted {
        client_id: client_id.to_string(),
        access_token,
        refresh_token,
        id_token,
        email: claims["email"].as_str().unwrap_or("").trim().to_string(),
        expires_in: body["expires_in"].as_i64().unwrap_or(3600),
        scopes: scopes_of(body),
    })
}

fn store(state: &AppState, row: &Value, ready: bool) -> Result<()> {
    let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let key_guard = state.vault_key.lock().unwrap_or_else(|e| e.into_inner());
    let mut secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
    let previous = secrets.get(PROVIDER).cloned().and_then(|raw| parse(&raw));
    let mut merged = row.clone();
    if text(&merged, "email").is_empty() {
        if let Some(previous) = previous.as_ref() {
            let email = text(previous, "email");
            if !email.is_empty() {
                merged["email"] = json!(email);
            }
        }
    }
    if text(&merged, "id_token").is_empty() {
        if let Some(previous) = previous.as_ref() {
            let id_token = text(previous, "id_token");
            if !id_token.is_empty() {
                merged["id_token"] = json!(id_token);
            }
        }
    }
    secrets.insert(PROVIDER.to_string(), format!("{PREFIX}{merged}"));
    crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
    let detail = if ready { "Signed in with ChatGPT." } else { "ChatGPT sign-in did not allow plan use." };
    conn.execute(
        "UPDATE provider_accounts SET has_secret=?1, health_detail=?2 WHERE id=?3",
        params![ready as i64, detail, PROVIDER],
    )?;
    Ok(())
}

fn form_post(url: &str, fields: &[(&str, &str)]) -> Result<Value> {
    let (status, raw) = crate::agent::http_call(crate::agent::HttpJob {
        method: "POST",
        url: url.to_string(),
        bearer: None,
        headers: Vec::new(),
        json_body: None,
        form: Some(fields.iter().map(|(key, value)| ((*key).to_string(), (*value).to_string())).collect()),
        limit: Duration::from_secs(20),
        cancel_on_refresh: false,
    }).map_err(err)?;
    let body: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    if !(200..300).contains(&status) {
        return Err(err(api_error(status, &body)));
    }
    Ok(body)
}

fn parse_sse(body: &str) -> std::result::Result<String, String> {
    let mut text = String::new();
    let mut failed = String::new();
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
        match event["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => text.push_str(event["delta"].as_str().unwrap_or("")),
            "response.failed" => {
                failed = event["response"]["error"]["code"].as_str().or_else(|| event["error"]["code"].as_str()).unwrap_or("response failed").to_string();
            }
            _ => {}
        }
    }
    if !failed.is_empty() {
        return Err(failed);
    }
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("ChatGPT returned an empty reply.".into());
    }
    Ok(trimmed)
}

fn wait_callback(listener: &TcpListener) -> Result<String> {
    listener.set_nonblocking(true).map_err(|error| err(error.to_string()))?;
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(180) {
            return Err(err("ChatGPT sign-in timed out. Continue with ChatGPT again."));
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(error) => return Err(err(error.to_string())),
        };
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let line = request.lines().next().unwrap_or("").to_string();
        let path = line.split_whitespace().nth(1).unwrap_or("");
        let callback = path.contains("/auth/callback") || path.contains("code=") || path.contains("error=");
        let page = if callback {
            "<!doctype html><meta charset=utf-8><title>Ronic OS</title><p>ChatGPT sign-in finished. Return to Ronic OS.</p>"
        } else {
            "<!doctype html><meta charset=utf-8><title>Ronic OS</title><p>Waiting for ChatGPT.</p>"
        };
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
        let _ = stream.write_all(response.as_bytes());
        if callback {
            return Ok(line);
        }
    }
}

fn open_browser(url: &str) -> Result<()> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")) {
        return Err(err("ChatGPT sign-in URL was rejected."));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        fn wide(value: &str) -> Vec<u16> {
            std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
        }
        let operation = wide("open");
        let file = wide(url);
        let code = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
        if code <= 32 {
            return Err(err(format!("could not open the ChatGPT sign-in page (Windows code {code}).")));
        }
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(url).spawn().map_err(|error| err(format!("could not open the ChatGPT sign-in page: {error}")))?;
    }
    Ok(())
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(hwnd: *mut std::ffi::c_void, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> isize;
}

fn host_id() -> Result<String> {
    let path = crate::util::product_home().join("siwc").join("host-id");
    if let Ok(saved) = std::fs::read_to_string(&path) {
        let saved = saved.trim();
        if saved.starts_with("urn:uuid:") {
            return Ok(saved.to_string());
        }
    }
    let bytes = random_bytes(16)?;
    let id = format!(
        "urn:uuid:{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &id)?;
    Ok(id)
}

fn client_path() -> PathBuf {
    crate::util::product_home().join("siwc").join("client-id")
}

fn saved_client() -> Option<String> {
    let saved = std::fs::read_to_string(client_path()).ok()?;
    let saved = saved.trim();
    if saved.is_empty() || saved == "dynamic_agent_client" { None } else { Some(saved.to_string()) }
}

fn parse(secret: &str) -> Option<Value> {
    let raw = secret.trim().strip_prefix(PREFIX)?;
    serde_json::from_str(raw).ok()
}

fn has_plan(row: &Value) -> bool {
    row["scopes"].as_array().is_some_and(|scopes| scopes.iter().any(|scope| scope.as_str() == Some(PLAN_SCOPE)))
}

fn due(row: &Value) -> bool {
    let expires = row["expires_at"].as_i64().unwrap_or(0);
    expires == 0 || expires < now_ms() + 60_000
}

fn text(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or("").trim().to_string()
}

fn scopes_of(body: &Value) -> Vec<String> {
    body["scope"].as_str().unwrap_or("").split_whitespace().map(str::to_string).collect()
}

fn id_claims(token: &str) -> Result<Value> {
    let payload = token.split('.').nth(1).ok_or_else(|| err("ChatGPT identity token was unreadable."))?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| err("ChatGPT identity token was unreadable."))?;
    serde_json::from_slice(&bytes).map_err(|_| err("ChatGPT identity token was unreadable."))
}

fn audience_matches(aud: &Value, client_id: &str) -> bool {
    if aud.as_str() == Some(client_id) {
        return true;
    }
    aud.as_array().is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(client_id)))
}

fn api_error(status: u16, body: &Value) -> String {
    let code = body["error"]["code"].as_str().unwrap_or("");
    let msg = body["error"]["message"].as_str().or_else(|| body["detail"].as_str()).unwrap_or("request failed");
    let msg: String = msg.chars().take(180).collect();
    if code.is_empty() { format!("HTTP {status}: {msg}") } else { format!("HTTP {status}: {code}") }
}

fn query_map(query: &str) -> std::collections::HashMap<String, String> {
    query.split('&').filter_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        Some((decode(key), decode(value)))
    }).collect()
}

fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_token(size: usize) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes(size)?))
}

fn random_bytes(size: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; size];
    getrandom::getrandom(&mut buf).map_err(|error| err(error.to_string()))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::{audience_matches, decode, parse_sse};
    use serde_json::json;

    #[test]
    fn sse_joins_deltas_and_surfaces_failure() {
        let ok = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\" there\"}\n";
        assert_eq!(parse_sse(ok).unwrap(), "Hello there");
        let bad = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n";
        assert!(parse_sse(bad).unwrap_err().contains("subscription_sharing_usage_limit_exceeded"));
    }

    #[test]
    fn query_decoding_and_audience() {
        assert_eq!(decode("a%40b.com"), "a@b.com");
        assert!(audience_matches(&json!("oaiapp_1"), "oaiapp_1"));
        assert!(audience_matches(&json!(["other", "oaiapp_1"]), "oaiapp_1"));
        assert!(!audience_matches(&json!("other"), "oaiapp_1"));
    }
}
