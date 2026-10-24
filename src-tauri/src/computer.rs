use crate::error::{err, Result};
use crate::models::DomNode;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

pub fn inspect(url: &str) -> Result<(Vec<DomNode>, i64)> {
    let parsed = url::Url::parse(url).map_err(|_| err("use an http or https URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(err("use an http or https URL"));
    }
    if inspect_target_blocked(&parsed) {
        return Err(err("that host cannot be inspected"));
    }
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if inspect_target_blocked(attempt.url()) {
                attempt.error(std::io::Error::new(std::io::ErrorKind::Other, "that host cannot be inspected"))
            } else if attempt.previous().len() > 5 {
                attempt.error(std::io::Error::new(std::io::ErrorKind::Other, "too many redirects"))
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| err(e.without_url().to_string()))?;
    let response = client.get(url).send().map_err(|e| err(format!("fetch failed: {}", e.without_url())))?;
    let status = response.status();
    let text = response.text().map_err(|e| err(e.without_url().to_string()))?;
    let slice = crate::util::prefix_utf8(&text, 400_000);
    let mut nodes = extract(slice);
    if nodes.is_empty() {
        nodes.push(DomNode { id: 1, tag: "document".into(), label: format!("HTTP {status}, no interactive tags in the first slice"), kind: "info".into() });
    }
    Ok((nodes, started.elapsed().as_millis() as i64))
}

fn extract(html: &str) -> Vec<DomNode> {
    let mut nodes = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() && nodes.len() < 40 {
        if bytes[i] == b'<' {
            let rest = &html[i + 1..];
            let tag = rest.split(|c: char| c.is_whitespace() || c == '>' || c == '/').next().unwrap_or("");
            let tag_l = tag.to_ascii_lowercase();
            if matches!(tag_l.as_str(), "a" | "button" | "input" | "select" | "textarea") {
                let end = rest.find('>').unwrap_or(rest.len().min(240));
                let raw = &rest[..end];
                let label = attr(raw, "aria-label")
                    .or_else(|| attr(raw, "placeholder"))
                    .or_else(|| attr(raw, "name"))
                    .or_else(|| attr(raw, "id"))
                    .unwrap_or_else(|| tag_l.clone());
                nodes.push(DomNode {
                    id: (nodes.len() + 1) as i64,
                    tag: tag_l,
                    label: clip(&label),
                    kind: "interactive".into(),
                });
                i += 1 + end;
                continue;
            }
        }
        i += 1;
    }
    nodes
}

fn attr(raw: &str, name: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let key = format!("{name}=\"");
    let idx = lower.find(&key)?;
    let start = idx + key.len();
    let value = raw.get(start..)?;
    let end = value.find('"')?;
    Some(value[..end].trim().to_string())
}

fn clip(s: &str) -> String {
    let mut t = s.replace('\n', " ");
    crate::util::truncate_utf8(&mut t, 80);
    t
}

fn inspect_target_blocked(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    if host.is_empty() || metadata_name(host) {
        return true;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip_blocked(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => ip_blocked(IpAddr::V6(ip)),
        Some(url::Host::Domain(domain)) => domain_resolves_blocked(domain),
        None => true,
    }
}

fn metadata_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "metadata.google.internal" || host.ends_with(".metadata.google.internal") || host == "metadata.internal"
}

fn ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                return false;
            }
            let octets = v4.octets();
            let cgnat = octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127;
            v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || cgnat
                || octets[0] == 0
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                return false;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ip_blocked(IpAddr::V4(v4));
            }
            let bits = v6.segments()[0];
            v6.is_unspecified() || v6.is_multicast() || (bits & 0xfe00) == 0xfc00 || (bits & 0xffc0) == 0xfe80
        }
    }
}

fn domain_resolves_blocked(host: &str) -> bool {
    let Ok(addrs) = (host, 80u16).to_socket_addrs() else {
        return true;
    };
    let mut saw = false;
    for addr in addrs {
        saw = true;
        if ip_blocked(addr.ip()) {
            return true;
        }
    }
    !saw
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_metadata_and_private_ips() {
        assert!(inspect_target_blocked(&url::Url::parse("http://169.254.169.254/latest").unwrap()));
        assert!(inspect_target_blocked(&url::Url::parse("http://metadata.google.internal/").unwrap()));
        assert!(inspect_target_blocked(&url::Url::parse("http://192.168.1.1/").unwrap()));
        assert!(inspect_target_blocked(&url::Url::parse("http://10.0.0.8/").unwrap()));
        assert!(inspect_target_blocked(&url::Url::parse("http://172.16.4.4/").unwrap()));
        assert!(inspect_target_blocked(&url::Url::parse("http://100.64.0.1/").unwrap()));
        assert!(inspect_target_blocked(&url::Url::parse("http://no-such-host.invalid/").unwrap()));
        assert!(!inspect_target_blocked(&url::Url::parse("http://1.1.1.1/").unwrap()));
        assert!(!inspect_target_blocked(&url::Url::parse("http://127.0.0.1:3000/").unwrap()));
    }
}
