use crate::models::WfNode;

pub fn emit(id: &str, name: &str, status: &str, paused: Option<&str>, triggers: &[String], nodes: &[WfNode], checkpoint: &serde_json::Map<String, serde_json::Value>) -> String {
    let mut out = String::new();
    out.push_str(&format!("id: {}\n", yaml_str(id)));
    out.push_str(&format!("name: {}\n", yaml_str(name)));
    out.push_str(&format!("status: {}\n", yaml_str(status)));
    if let Some(p) = paused {
        out.push_str(&format!("paused_at: {}\n", yaml_str(p)));
    }
    out.push_str("triggers:\n");
    for t in triggers {
        out.push_str(&format!("  - {}\n", yaml_str(t)));
    }
    out.push_str("nodes:\n");
    for n in nodes {
        out.push_str(&format!("  - id: {}\n", yaml_str(&n.id)));
        out.push_str(&format!("    name: {}\n", yaml_str(&n.name)));
        out.push_str(&format!("    kind: {}\n", yaml_str(&n.kind)));
        out.push_str(&format!("    bot: {}\n", yaml_str(&n.bot_profile)));
        out.push_str(&format!("    model: {}\n", yaml_str(&n.model)));
        out.push_str(&format!("    status: {}\n", yaml_str(&n.status)));
        out.push_str(&format!("    latency_ms: {}\n", n.latency_ms));
        out.push_str(&format!("    prompt: {}\n", yaml_str(&n.prompt)));
    }
    if !checkpoint.is_empty() {
        out.push_str("checkpoint:\n");
        for (k, v) in checkpoint {
            let text = match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push_str(&format!("  {}: {}\n", yaml_str(k), yaml_str(&text)));
        }
    }
    out
}

fn yaml_str(s: &str) -> String {
    if s.is_empty() || s.contains([':', '#', '"', '\'', '\n', '\r', '\t']) || s.starts_with(' ') || s.ends_with(' ') {
        format!("\"{}\"", s.chars().flat_map(|ch| match ch {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            other => vec![other],
        }).collect::<String>())
    } else {
        s.to_string()
    }
}

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let mut out = String::new();
        let mut chars = s[1..s.len() - 1].chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some(other) => out.push(other),
                    None => out.push('\\'),
                }
            } else {
                out.push(ch);
            }
        }
        out
    } else {
        s.to_string()
    }
}

pub fn parse(text: &str) -> Result<(String, String, String, Option<String>, Vec<String>, Vec<WfNode>, serde_json::Map<String, serde_json::Value>), String> {
    let mut id = String::new();
    let mut name = String::new();
    let mut status = String::from("idle");
    let mut paused: Option<String> = None;
    let mut triggers = Vec::new();
    let mut nodes = Vec::new();
    let mut checkpoint = serde_json::Map::new();
    let mut section = "";
    let mut current: Option<WfNode> = None;

    let flush = |current: &mut Option<WfNode>, nodes: &mut Vec<WfNode>| {
        if let Some(node) = current.take() {
            nodes.push(node);
        }
    };

    if text.len() > 1_000_000 {
        return Err("workflow yaml is too large (1 MB limit)".into());
    }
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim().starts_with('#') {
            continue;
        }
        if section == "checkpoint" && (line.starts_with("  ") || line.starts_with('\t')) {
            let (k, v) = split_kv(line.trim()).ok_or_else(|| format!("bad checkpoint line: {line}"))?;
            checkpoint.insert(k.to_string(), serde_json::Value::String(v));
            continue;
        }
        if let Some(rest) = line.trim().strip_prefix("- id:") {
            flush(&mut current, &mut nodes);
            section = "nodes";
            current = Some(WfNode {
                id: unquote(rest),
                name: String::new(),
                kind: "bot_action".into(),
                bot_profile: String::new(),
                model: String::new(),
                prompt: String::new(),
                status: "pending".into(),
                latency_ms: 0,
            });
            continue;
        }
        if section == "triggers" {
            if let Some(rest) = line.trim().strip_prefix("- ") {
                triggers.push(unquote(rest));
                continue;
            }
        }
        if line.starts_with("  ") || line.starts_with('\t') {
            if section == "nodes" {
                let node = current.as_mut().ok_or_else(|| format!("node property without a node: {line}"))?;
                let (k, v) = split_kv(line.trim()).ok_or_else(|| format!("bad node line: {line}"))?;
                match k {
                    "name" => node.name = v,
                    "kind" => node.kind = v,
                    "bot" => node.bot_profile = v,
                    "model" => node.model = v,
                    "status" => node.status = v,
                    "latency_ms" => node.latency_ms = v.parse().map_err(|_| "latency_ms must be a non-negative integer".to_string())?,
                    "prompt" => node.prompt = v,
                    "id" => node.id = v,
                    _ => {}
                }
            }
            continue;
        }
        let (k, v) = split_kv(line.trim()).ok_or_else(|| format!("bad line: {line}"))?;
        match k {
            "id" => id = v,
            "name" => name = v,
            "status" => status = v,
            "paused_at" => paused = Some(v),
            "triggers" => section = "triggers",
            "nodes" => section = "nodes",
            "checkpoint" => section = "checkpoint",
            _ => {}
        }
    }
    flush(&mut current, &mut nodes);
    if id.is_empty() || nodes.is_empty() {
        return Err("workflow yaml needs an id and at least one node".into());
    }
    if name.is_empty() {
        name = id.clone();
    }
    if nodes.len() > 200 {
        return Err("workflow has too many steps (200 limit)".into());
    }
    let mut ids = std::collections::HashSet::new();
    for node in &nodes {
        if node.id.trim().is_empty() || !ids.insert(node.id.as_str()) {
            return Err("every workflow step needs a unique id".into());
        }
        if node.latency_ms < 0 {
            return Err("latency_ms must be non-negative".into());
        }
    }
    if paused.as_ref().is_some_and(|node_id| !ids.contains(node_id.as_str())) {
        return Err("paused_at must refer to a workflow step".into());
    }
    Ok((id, name, status, paused, triggers, nodes, checkpoint))
}

fn split_kv(line: &str) -> Option<(&str, String)> {
    let (k, v) = line.split_once(':')?;
    Some((k.trim(), unquote(v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let nodes = vec![WfNode {
            id: "node_1".into(),
            name: "@Grokbot Scrape".into(),
            kind: "bot_action".into(),
            bot_profile: "@Grokbot-Scout".into(),
            model: "grok".into(),
            prompt: "Extract catalysts: top 5".into(),
            status: "done".into(),
            latency_ms: 12,
        }];
        let triggers = vec!["cron: 0 8 * * *".into()];
        let mut checkpoint = serde_json::Map::new();
        checkpoint.insert("node_1".to_string(), serde_json::Value::String("test output".to_string()));
        let yaml = emit("wf_market", "Morning", "paused_editable", Some("node_1"), &triggers, &nodes, &checkpoint);
        let (_id, _name, status, paused, trig, parsed, parsed_checkpoint) = parse(&yaml).unwrap();
        assert_eq!(status, "paused_editable");
        assert_eq!(paused.as_deref(), Some("node_1"));
        assert_eq!(trig, triggers);
        assert_eq!(parsed[0].prompt, "Extract catalysts: top 5");
        assert_eq!(parsed[0].latency_ms, 12);
        assert_eq!(parsed_checkpoint.get("node_1").and_then(|v| v.as_str()), Some("test output"));
    }

    #[test]
    fn multiline_and_unicode_survive_round_trip() {
        let nodes = vec![WfNode {
            id: "node_1".into(), name: "Unicode 漢字".into(), kind: "llm_reasoning".into(), bot_profile: String::new(), model: String::new(),
            prompt: "first line\nsecond \"quoted\" \\ path\ttab".into(), status: "pending".into(), latency_ms: 0,
        }];
        let mut checkpoint = serde_json::Map::new();
        checkpoint.insert("node_1".into(), serde_json::Value::String("line one\nline two".into()));
        let yaml = emit("wf_1", "Test", "idle", None, &[], &nodes, &checkpoint);
        let parsed = parse(&yaml).unwrap();
        assert_eq!(parsed.5[0].prompt, nodes[0].prompt);
        assert_eq!(parsed.5[0].name, nodes[0].name);
        assert_eq!(parsed.6.get("node_1").and_then(|v| v.as_str()), Some("line one\nline two"));
    }

    #[test]
    fn invalid_node_ids_are_rejected() {
        let yaml = "id: wf_1\nname: Test\nnodes:\n  - id: node_1\n  - id: node_1\n";
        assert!(parse(yaml).unwrap_err().contains("unique"));
        assert!(parse("id: wf_1\nname: Test\nnodes:\n  - id: node_1\npaused_at: missing\n").is_err());
    }
}
