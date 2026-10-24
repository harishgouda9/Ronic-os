use regex::Regex;
use std::sync::OnceLock;

fn patterns() -> &'static [Regex] {
    static PATS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATS.get_or_init(|| {
        [
            r"(?i)\bsk-ant-[A-Za-z0-9_\-]{8,}",
            r"(?i)\bsk-(proj|live|test)-[A-Za-z0-9_\-]{8,}",
            r"(?i)\bsk-[A-Za-z0-9]{16,}",
            r"(?i)\brk_(live|test)_[A-Za-z0-9]{8,}",
            r"(?i)\bwhsec_[A-Za-z0-9]{8,}",
            r"(?i)\bgh[pousr]_[A-Za-z0-9]{20,}",
            r"(?i)\bbearer\s+[A-Za-z0-9\-_\.=]{8,}",
            r#"(?i)(api[_-]?key|secret|token|password|seed)\s*[:=]\s*["']?[^\s"',]{6,}"#,
        ]
        .into_iter()
        .map(|p| Regex::new(p).expect("redaction pattern"))
        .collect()
    })
}

pub fn redact(input: &str) -> String {
    let mut out = input.to_string();
    for pat in patterns() {
        out = pat
            .replace_all(&out, |caps: &regex::Captures| {
                let full = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                if let Some(idx) = full.find(':').or_else(|| full.find('=')) {
                    format!("{}***REDACTED***", &full[..=idx])
                } else if let Some(prefix) = full.split('-').next() {
                    if prefix.len() < full.len() && prefix.len() <= 12 {
                        format!("{prefix}-***REDACTED***")
                    } else {
                        "***REDACTED***".to_string()
                    }
                } else {
                    "***REDACTED***".to_string()
                }
            })
            .to_string();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_provider_keys_and_assignments() {
        let raw = "failed with sk-ant-api03-abcdefghijklmnopqrstuvwxyz and api_key=supersecretvalue bearer abcdefghijklmnop";
        let clean = redact(raw);
        assert!(!clean.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(!clean.contains("supersecretvalue"));
        assert!(!clean.contains("abcdefghijklmnop"));
        assert!(clean.contains("REDACTED"));
    }

    #[test]
    fn leaves_ordinary_prose() {
        let raw = "Claude Max quota is 78% and the vault is local.";
        assert_eq!(redact(raw), raw);
    }
}
