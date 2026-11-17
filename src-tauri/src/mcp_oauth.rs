//! OAuth discovery for the public MCP alias.
//!
//! ChatGPT and Claude fill the rest of a custom connector only after the MCP
//! URL answers with protected-resource metadata and an authorization server
//! that does PKCE. A 405 or a bare 401 leaves the form half empty and the
//! connector never finishes.

use crate::util::now_ms;
use crate::workspace_bridge;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const CODE_TTL_MS: i64 = 300_000;
const TOKEN_TTL_SECS: u64 = 30 * 24 * 3600;
const CONSENT_MS: i64 = 3 * 60_000;

struct Pending {
    challenge: String,
    redirect: String,
    client_id: String,
    scope: String,
    expires_ms: i64,
}

pub struct Store {
    codes: HashMap<String, Pending>,
    refreshes: Vec<String>,
    consent_until: i64,
}

impl Store {
    pub fn new() -> Self {
        Self { codes: HashMap::new(), refreshes: Vec::new(), consent_until: 0 }
    }
}

/// A local click opened the connector. The next `/authorize` in this window may issue a code.
/// shortcut: a poller can race the 3 minute window, upgrade when the click must match one code_challenge.
pub fn arm_consent() {
    arm_store(store());
}

pub fn arm_store(store: &Mutex<Store>) {
    let mut guard = store.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.consent_until = now_ms() + CONSENT_MS;
}

pub fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::new()))
}

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Authorized POST /mcp. The caller runs the JSON-RPC handler.
    pub rpc: bool,
}

pub fn dispatch(store: &Mutex<Store>, method: &str, target: &str, headers: &[(String, String)], body: &[u8], token: &str) -> Reply {
    // The Dock browser hits 127.0.0.1. ChatGPT still checks iss against the public issuer.
    let origin = issuer_origin(&public_origin(headers), crate::tunnel::public_site_origin().as_deref());
    let path = path_only(target);
    if method == "OPTIONS" {
        return empty(204);
    }
    match (method, path) {
        ("GET", "/.well-known/oauth-protected-resource") | ("GET", "/.well-known/oauth-protected-resource/mcp") => protected(&origin),
        ("GET", "/.well-known/oauth-authorization-server")
        | ("GET", "/.well-known/oauth-authorization-server/mcp")
        | ("GET", "/.well-known/openid-configuration") => metadata(&origin),
        ("POST", "/register") => register(body),
        ("GET", "/authorize") => authorize(store, target, &origin),
        ("POST", "/token") => exchange(store, headers, body, token),
        (_, "/mcp") => mcp(method, target, headers, token, &origin),
        _ => json_reply(404, json!({"error": "not found"}), Vec::new()),
    }
}

fn mcp(method: &str, target: &str, headers: &[(String, String)], token: &str, origin: &str) -> Reply {
    // Discovery probes GET this URL before it ever POSTs. A 405 with no
    // WWW-Authenticate makes ChatGPT report that the server has no OAuth,
    // so the advanced fields stay blank.
    if !workspace_bridge::authorized(token, target, headers) {
        return unauthorized(origin);
    }
    if method == "POST" {
        return Reply { status: 200, content_type: "application/json", headers: Vec::new(), body: Vec::new(), rpc: true };
    }
    json_reply(405, json!({"error": "use POST"}), vec![("Allow".into(), "POST".into())])
}

fn protected(origin: &str) -> Reply {
    json_reply(
        200,
        json!({
            "resource": format!("{origin}/mcp"),
            "authorization_servers": [origin],
            "bearer_methods_supported": ["header"],
            "scopes_supported": ["ronic", "offline_access"]
        }),
        Vec::new(),
    )
}

fn metadata(origin: &str) -> Reply {
    json_reply(
        200,
        json!({
            "issuer": origin,
            "authorization_endpoint": format!("{origin}/authorize"),
            "token_endpoint": format!("{origin}/token"),
            "registration_endpoint": format!("{origin}/register"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "client_id_metadata_document_supported": true,
            "authorization_response_iss_parameter_supported": true,
            "scopes_supported": ["ronic", "offline_access"]
        }),
        Vec::new(),
    )
}

fn register(body: &[u8]) -> Reply {
    let value: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
    let uris = value.get("redirect_uris").cloned().unwrap_or_else(|| json!([]));
    if let Some(list) = uris.as_array() {
        for uri in list {
            let Some(uri) = uri.as_str() else {
                return oauth_error(400, "invalid_redirect_uri");
            };
            if !redirect_allowed(uri) {
                return oauth_error(400, "invalid_redirect_uri");
            }
        }
    } else {
        return oauth_error(400, "invalid_client_metadata");
    }
    let given = value.get("client_id").and_then(Value::as_str).unwrap_or("");
    let client_id = if !given.is_empty() && given.len() <= 500 { given.to_string() } else { format!("ronic-{}", random_hex(8)) };
    if client_id.is_empty() {
        return oauth_error(500, "server_error");
    }
    json_reply(
        201,
        json!({
            "client_id": client_id,
            "client_id_issued_at": now_ms() / 1000,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "redirect_uris": uris
        }),
        Vec::new(),
    )
}

fn authorize(store: &Mutex<Store>, target: &str, origin: &str) -> Reply {
    let query = form_map(target.split_once('?').map(|(_, query)| query).unwrap_or(""));
    let redirect = query.get("redirect_uri").map(String::as_str).unwrap_or("");
    let challenge = query.get("code_challenge").map(String::as_str).unwrap_or("");
    let method = query.get("code_challenge_method").map(String::as_str).unwrap_or("");
    let response = query.get("response_type").map(String::as_str).unwrap_or("code");
    let client_id = query.get("client_id").map(String::as_str).unwrap_or("");
    if response != "code" || challenge.len() < 20 || challenge.len() > 200 || method != "S256" || client_id.is_empty() || client_id.len() > 500 {
        return oauth_error(400, "invalid_request");
    }
    if !redirect_allowed(redirect) {
        return oauth_error(400, "invalid_redirect_uri");
    }
    // shortcut: CIMD documents are not fetched, upgrade when a client outside the redirect allowlist must be rejected.
    let open = store.lock().unwrap_or_else(|poison| poison.into_inner()).consent_until > now_ms();
    if !open {
        return oauth_error(403, "access_denied");
    }
    let code = random_hex(32);
    if code.is_empty() {
        return oauth_error(500, "server_error");
    }
    let scope = query.get("scope").map(String::as_str).unwrap_or("ronic").chars().take(200).collect::<String>();
    {
        let mut guard = store.lock().unwrap_or_else(|poison| poison.into_inner());
        let now = now_ms();
        guard.codes.retain(|_, item| item.expires_ms > now);
        if guard.codes.len() > 64 {
            guard.codes.clear();
        }
        guard.codes.insert(code.clone(), Pending {
            challenge: challenge.to_string(),
            redirect: redirect.to_string(),
            client_id: client_id.to_string(),
            scope,
            expires_ms: now + CODE_TTL_MS,
        });
    }
    let state = query.get("state").map(String::as_str).unwrap_or("");
    // The browser may be on 127.0.0.1. ChatGPT expects iss to be the public server it saved.
    let origin = authorize_issuer(&query, origin);
    let location = append_query(redirect, &[("code", code.as_str()), ("state", state), ("iss", &origin)]);
    Reply {
        status: 302,
        content_type: "text/plain",
        headers: vec![("Location".into(), location)],
        body: Vec::new(),
        rpc: false,
    }
}

fn exchange(store: &Mutex<Store>, headers: &[(String, String)], body: &[u8], token: &str) -> Reply {
    if token.is_empty() {
        return oauth_error(500, "server_error");
    }
    let form = body_map(headers, body);
    let grant = form.get("grant_type").map(String::as_str).unwrap_or("");
    if grant == "refresh_token" {
        let refresh = form.get("refresh_token").map(String::as_str).unwrap_or("");
        let known = store.lock().unwrap_or_else(|poison| poison.into_inner()).refreshes.iter().any(|item| item == refresh);
        if !known {
            return oauth_error(400, "invalid_grant");
        }
        return token_body(token, refresh, "ronic offline_access");
    }
    if grant != "authorization_code" {
        return oauth_error(400, "unsupported_grant_type");
    }
    let code = form.get("code").map(String::as_str).unwrap_or("").to_string();
    let verifier = form.get("code_verifier").map(String::as_str).unwrap_or("");
    let redirect = form.get("redirect_uri").map(String::as_str).unwrap_or("");
    let client_id = form.get("client_id").map(String::as_str).unwrap_or("");
    let pending = {
        let mut guard = store.lock().unwrap_or_else(|poison| poison.into_inner());
        guard.codes.remove(&code)
    };
    let Some(pending) = pending else {
        return oauth_error(400, "invalid_grant");
    };
    if pending.expires_ms < now_ms() || pending.redirect != redirect || (!client_id.is_empty() && client_id != pending.client_id) || s256(verifier) != pending.challenge {
        return oauth_error(400, "invalid_grant");
    }
    let refresh = random_hex(32);
    if refresh.is_empty() {
        return oauth_error(500, "server_error");
    }
    {
        let mut guard = store.lock().unwrap_or_else(|poison| poison.into_inner());
        if guard.refreshes.len() >= 32 {
            guard.refreshes.remove(0);
        }
        guard.refreshes.push(refresh.clone());
    }
    token_body(token, &refresh, &pending.scope)
}

fn token_body(access: &str, refresh: &str, scope: &str) -> Reply {
    json_reply(
        200,
        json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": TOKEN_TTL_SECS,
            "refresh_token": refresh,
            "scope": scope
        }),
        Vec::new(),
    )
}

fn unauthorized(origin: &str) -> Reply {
    let metadata = format!("{origin}/.well-known/oauth-protected-resource/mcp");
    json_reply(
        401,
        json!({"error": "unauthorized"}),
        vec![
            ("WWW-Authenticate".into(), format!("Bearer resource_metadata=\"{metadata}\", scope=\"ronic\"")),
            ("Access-Control-Expose-Headers".into(), "WWW-Authenticate".into()),
        ],
    )
}

fn oauth_error(status: u16, code: &str) -> Reply {
    json_reply(status, json!({"error": code}), Vec::new())
}

fn json_reply(status: u16, value: Value, headers: Vec<(String, String)>) -> Reply {
    Reply {
        status,
        content_type: "application/json",
        headers,
        body: serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()),
        rpc: false,
    }
}

fn empty(status: u16) -> Reply {
    Reply { status, content_type: "text/plain", headers: Vec::new(), body: Vec::new(), rpc: false }
}

fn path_only(target: &str) -> &str {
    let path = target.split('?').next().unwrap_or(target).trim_end_matches('/');
    if path.is_empty() { "/" } else { path }
}

fn authorize_issuer(query: &HashMap<String, String>, fallback: &str) -> String {
    if let Some(resource) = query.get("resource") {
        if let Some(origin) = https_origin(resource) {
            if public_mcp_host(&origin) {
                return origin;
            }
        }
    }
    let fallback = fallback.trim().trim_end_matches('/');
    if public_mcp_host(fallback) {
        return fallback.to_string();
    }
    fallback.to_string()
}

fn https_origin(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.len() > 300 || raw.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    })
}

fn public_mcp_host(origin: &str) -> bool {
    let host = origin.split("://").nth(1).unwrap_or(origin);
    let host = host.split('/').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    host.ends_with(".trycloudflare.com") || host == "ronic.os" || host.ends_with(".vercel.app")
}

fn issuer_origin(request_origin: &str, public_site: Option<&str>) -> String {
    if local_origin(request_origin) {
        if let Some(site) = public_site.map(str::trim).map(|site| site.trim_end_matches('/')) {
            if site.starts_with("https://") && site.len() < 300 && !site.bytes().any(|byte| byte.is_ascii_whitespace()) {
                return site.to_string();
            }
        }
    }
    request_origin.to_string()
}

fn local_origin(origin: &str) -> bool {
    let host = origin.split("://").nth(1).unwrap_or(origin);
    let host = host.split('/').next().unwrap_or(host);
    let host = host.split('@').next_back().unwrap_or(host);
    let name = host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host);
    name == "localhost" || name == "127.0.0.1"
}

fn public_origin(headers: &[(String, String)]) -> String {
    // The Vercel door sets this. Cloudflare may replace X-Forwarded-Host with the tunnel host.
    if let Some(door) = header(headers, "x-ronic-door") {
        let door = door.split(',').next().unwrap_or("").trim();
        if door == "ronicos.vercel.app" {
            return "https://ronicos.vercel.app".to_string();
        }
    }
    let raw = header(headers, "x-forwarded-host").or_else(|| header(headers, "host")).unwrap_or("127.0.0.1:8765");
    let host = raw.split(',').next().unwrap_or(raw).trim();
    let forwarded = header(headers, "x-forwarded-proto").unwrap_or("");
    let proto = forwarded.split(',').next().unwrap_or("").trim();
    let proto = if proto == "http" || proto == "https" {
        proto
    } else if host.starts_with("127.") || host.starts_with("localhost") {
        "http"
    } else {
        "https"
    };
    format!("{proto}://{host}")
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

fn redirect_allowed(uri: &str) -> bool {
    if uri.len() > 2000 || uri.bytes().any(|byte| byte.is_ascii_whitespace() || byte == b'\r' || byte == b'\n') {
        return false;
    }
    let Ok(url) = url::Url::parse(uri) else {
        return false;
    };
    if url.fragment().is_some() {
        return false;
    }
    let host = url.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    if url.scheme() == "http" {
        return host == "localhost" || host == "127.0.0.1";
    }
    url.scheme() == "https" && host_ok(&host)
}

fn host_ok(host: &str) -> bool {
    const ROOTS: &[&str] = &["chatgpt.com", "openai.com", "claude.ai", "claude.com", "anthropic.com", "grok.com", "x.ai"];
    ROOTS.iter().any(|root| host == *root || host.ends_with(&format!(".{root}")))
}

fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if getrandom::getrandom(&mut buf).is_err() {
        return String::new();
    }
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn body_map(headers: &[(String, String)], body: &[u8]) -> HashMap<String, String> {
    let ctype = header(headers, "content-type").unwrap_or("");
    if ctype.contains("json") || body.first() == Some(&b'{') {
        if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(body) {
            return map.into_iter().filter_map(|(key, value)| value.as_str().map(|text| (key, text.to_string()))).collect();
        }
    }
    form_map(&String::from_utf8_lossy(body))
}

fn form_map(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(decode(key), decode(value));
    }
    map
}

fn decode(raw: &str) -> String {
    let mut out = Vec::new();
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&raw[index + 1..index + 3], 16) {
                    out.push(byte);
                    index += 3;
                } else {
                    out.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
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

fn append_query(uri: &str, pairs: &[(&str, &str)]) -> String {
    let mut extra = String::new();
    for (key, value) in pairs {
        if !extra.is_empty() {
            extra.push('&');
        }
        extra.push_str(key);
        extra.push('=');
        extra.push_str(&encode(value));
    }
    if uri.contains('?') { format!("{uri}&{extra}") } else { format!("{uri}?{extra}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const BRIDGE: &str = "bridge-token-0123456789abcdef";

    fn cloud() -> Vec<(String, String)> {
        vec![
            ("Host".into(), "xyz.trycloudflare.com".into()),
            ("X-Forwarded-Proto".into(), "https".into()),
        ]
    }

    fn head<'a>(reply: &'a Reply, name: &str) -> &'a str {
        reply.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str()).unwrap_or("")
    }

    #[test]
    fn pkce_matches_the_rfc_vector() {
        assert_eq!(s256(VERIFIER), CHALLENGE);
    }

    #[test]
    fn door_header_sets_the_vercel_issuer() {
        let store = Mutex::new(Store::new());
        let door = vec![
            ("Host".into(), "127.0.0.1:8765".into()),
            ("X-Ronic-Door".into(), "ronicos.vercel.app".into()),
        ];
        let resource = dispatch(&store, "GET", "/.well-known/oauth-protected-resource/mcp", &door, b"", BRIDGE);
        let doc: Value = serde_json::from_slice(&resource.body).unwrap();
        assert_eq!(doc["resource"], "https://ronicos.vercel.app/mcp");
        assert_eq!(doc["authorization_servers"][0], "https://ronicos.vercel.app");
        let target = format!(
            "/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json&redirect_uri={}&state=abc&code_challenge={CHALLENGE}&code_challenge_method=S256&resource={}",
            encode("https://chatgpt.com/connector_platform_oauth_redirect"),
            encode("https://ronicos.vercel.app/mcp")
        );
        arm_store(&store);
        let redirected = dispatch(&store, "GET", &target, &door, b"", BRIDGE);
        assert_eq!(redirected.status, 302, "{}", String::from_utf8_lossy(&redirected.body));
        let location = head(&redirected, "Location");
        assert!(location.contains("iss=https%3A%2F%2Fronicos.vercel.app"), "{location}");
        assert!(!location.contains("127.0.0.1"), "{location}");
        let mut spoofed = cloud();
        spoofed.push(("X-Ronic-Door".into(), "evil.example".into()));
        let ignored = dispatch(&store, "GET", "/.well-known/oauth-protected-resource/mcp", &spoofed, b"", BRIDGE);
        let ignored_doc: Value = serde_json::from_slice(&ignored.body).unwrap();
        assert_eq!(ignored_doc["resource"], "https://xyz.trycloudflare.com/mcp");
        let loopback = vec![("Host".into(), "127.0.0.1:8765".into())];
        let from_resource = dispatch(&store, "GET", &target, &loopback, b"", BRIDGE);
        let from_location = head(&from_resource, "Location");
        assert!(from_location.contains("iss=https%3A%2F%2Fronicos.vercel.app"), "{from_location}");
        assert!(!from_location.contains("127.0.0.1"), "{from_location}");
    }

    #[test]
    fn loopback_authorize_issuer_matches_the_resource() {
        let store = Mutex::new(Store::new());
        let headers = vec![("Host".into(), "127.0.0.1:8765".into())];
        let target = format!(
            "/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json&redirect_uri={}&state=abc&code_challenge={CHALLENGE}&code_challenge_method=S256&resource={}",
            encode("https://chatgpt.com/connector_platform_oauth_redirect"),
            encode("https://xyz.trycloudflare.com/mcp")
        );
        arm_store(&store);
        let redirected = dispatch(&store, "GET", &target, &headers, b"", BRIDGE);
        assert_eq!(redirected.status, 302, "{}", String::from_utf8_lossy(&redirected.body));
        let location = head(&redirected, "Location");
        assert!(location.contains("iss=https%3A%2F%2Fxyz.trycloudflare.com"), "{location}");
        assert!(!location.contains("127.0.0.1"), "{location}");
        let mut evil = HashMap::new();
        evil.insert("resource".into(), "https://evil.example/mcp".into());
        assert_eq!(authorize_issuer(&evil, "https://xyz.trycloudflare.com"), "https://xyz.trycloudflare.com");
    }

    #[test]
    fn local_authorize_uses_the_public_issuer() {
        assert_eq!(issuer_origin("http://127.0.0.1:8765", Some("https://xyz.trycloudflare.com/")), "https://xyz.trycloudflare.com");
        assert_eq!(issuer_origin("https://xyz.trycloudflare.com", Some("https://other.example")), "https://xyz.trycloudflare.com");
        assert_eq!(issuer_origin("http://127.0.0.1:8765", None), "http://127.0.0.1:8765");
        assert_eq!(issuer_origin("http://127.0.0.1:8765", Some("http://evil.example")), "http://127.0.0.1:8765");
    }

    #[test]
    fn unauthenticated_probe_is_oauth_not_a_bare_405() {
        let store = Mutex::new(Store::new());
        let headers = cloud();
        let get = dispatch(&store, "GET", "/mcp", &headers, b"", BRIDGE);
        assert_eq!(get.status, 401);
        assert!(!get.rpc);
        assert!(head(&get, "WWW-Authenticate").contains("https://xyz.trycloudflare.com/.well-known/oauth-protected-resource/mcp"));
        let post = dispatch(&store, "POST", "/mcp", &headers, b"{}", BRIDGE);
        assert_eq!(post.status, 401);
        let resource = dispatch(&store, "GET", "/.well-known/oauth-protected-resource/mcp", &headers, b"", BRIDGE);
        let doc: Value = serde_json::from_slice(&resource.body).unwrap();
        assert_eq!(doc["resource"], "https://xyz.trycloudflare.com/mcp");
        assert_eq!(doc["authorization_servers"][0], "https://xyz.trycloudflare.com");
        let meta = dispatch(&store, "GET", "/.well-known/oauth-authorization-server", &headers, b"", BRIDGE);
        let as_doc: Value = serde_json::from_slice(&meta.body).unwrap();
        assert_eq!(as_doc["authorization_endpoint"], "https://xyz.trycloudflare.com/authorize");
        assert_eq!(as_doc["token_endpoint"], "https://xyz.trycloudflare.com/token");
        assert_eq!(as_doc["registration_endpoint"], "https://xyz.trycloudflare.com/register");
        assert_eq!(as_doc["client_id_metadata_document_supported"], true);
        assert_eq!(as_doc["authorization_response_iss_parameter_supported"], true);
        assert!(as_doc["code_challenge_methods_supported"].to_string().contains("S256"));
    }

    #[test]
    fn authorization_code_issues_the_bridge_token_once() {
        let store = Mutex::new(Store::new());
        let headers = cloud();
        let target = format!(
            "/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient&redirect_uri={}&state=abc&code_challenge={CHALLENGE}&code_challenge_method=S256",
            encode("https://chatgpt.com/connector/oauth/cb123?foo=1")
        );
        arm_store(&store);
        let redirected = dispatch(&store, "GET", &target, &headers, b"", BRIDGE);
        assert_eq!(redirected.status, 302, "{}", String::from_utf8_lossy(&redirected.body));
        let location = head(&redirected, "Location");
        assert!(location.starts_with("https://chatgpt.com/connector/oauth/cb123?foo=1&code="), "{location}");
        assert!(location.contains("&state=abc&"));
        assert!(location.contains("iss=https%3A%2F%2Fxyz.trycloudflare.com"), "{location}");
        let code = location.split("code=").nth(1).unwrap().split('&').next().unwrap();
        let body = format!("grant_type=authorization_code&code={code}&redirect_uri={}&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient&code_verifier={VERIFIER}", encode("https://chatgpt.com/connector/oauth/cb123?foo=1"));
        let form = [("Content-Type".into(), "application/x-www-form-urlencoded".into())];
        let issued = dispatch(&store, "POST", "/token", &form, body.as_bytes(), BRIDGE);
        let doc: Value = serde_json::from_slice(&issued.body).unwrap();
        assert_eq!(issued.status, 200, "{doc}");
        assert_eq!(doc["access_token"], BRIDGE);
        assert_eq!(doc["token_type"], "Bearer");
        let again = dispatch(&store, "POST", "/token", &form, body.as_bytes(), BRIDGE);
        assert_eq!(again.status, 400);
        let bad = format!("grant_type=authorization_code&code=nope&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb&code_verifier={VERIFIER}");
        let rejected = dispatch(&store, "POST", "/token", &form, bad.as_bytes(), BRIDGE);
        assert!(!String::from_utf8_lossy(&rejected.body).contains(BRIDGE));
        let authed = [("Authorization".into(), format!("Bearer {BRIDGE}"))];
        let rpc = dispatch(&store, "POST", "/mcp", &authed, b"{}", BRIDGE);
        assert!(rpc.rpc);
        let query = dispatch(&store, "POST", &format!("/mcp?token={BRIDGE}"), &[], b"{}", BRIDGE);
        assert!(query.rpc);
    }

    #[test]
    fn authorize_without_a_local_click_does_not_issue_a_code() {
        let store = Mutex::new(Store::new());
        let headers = cloud();
        let target = format!(
            "/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient&redirect_uri={}&state=abc&code_challenge={CHALLENGE}&code_challenge_method=S256",
            encode("https://chatgpt.com/connector/oauth/cb123?foo=1")
        );
        let denied = dispatch(&store, "GET", &target, &headers, b"", BRIDGE);
        assert_eq!(denied.status, 403);
        assert!(head(&denied, "Location").is_empty());
        assert!(!String::from_utf8_lossy(&denied.body).contains(BRIDGE));
    }

    #[test]
    fn foreign_redirect_and_bad_registration_are_rejected() {
        let store = Mutex::new(Store::new());
        let headers = cloud();
        let evil = format!("/authorize?response_type=code&client_id=chatgpt&redirect_uri={}&code_challenge={CHALLENGE}&code_challenge_method=S256", encode("https://evil.example/steal"));
        let denied = dispatch(&store, "GET", &evil, &headers, b"", BRIDGE);
        assert_eq!(denied.status, 400);
        assert!(head(&denied, "Location").is_empty());
        let registered = dispatch(
            &store,
            "POST",
            "/register",
            &headers,
            br#"{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}"#,
            BRIDGE,
        );
        assert_eq!(registered.status, 201);
        let blocked = dispatch(&store, "POST", "/register", &headers, br#"{"redirect_uris":["https://evil.example/cb"]}"#, BRIDGE);
        assert_eq!(blocked.status, 400);
        assert!(!String::from_utf8_lossy(&blocked.body).contains(BRIDGE));
    }
}
