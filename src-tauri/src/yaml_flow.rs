use crate::models::WfNode;

pub fn emit(id: &str, name: &str, status: &str, paused: Option<&str>, triggers: &[String], nodes: &[WfNode]) -> String {
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
    out
}

fn yaml_str(s: &str) -> String {
    if s.is_empty() || s.contains([':', '#', '"', '\'', '\n']) || s.starts_with(' ') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " "))
    } else {
        s.to_string()
    }
}

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        s.to_string()
    }
}

pub fn parse(text: &str) -> Result<(String, String, String, Option<String>, Vec<String>, Vec<WfNode>), String> {
    let mut id = String::new();
    let mut name = String::new();
    let mut status = String::from("idle");
    let mut paused: Option<String> = None;
    let mut triggers = Vec::new();
    let mut nodes = Vec::new();
    let mut section = "";
    let mut current: Option<WfNode> = None;

    let flush = |current: &mut Option<WfNode>, nodes: &mut Vec<WfNode>| {
        if let Some(node) = current.take() {
            nodes.push(node);
        }
    };

    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim().starts_with('#') {
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
            if let Some(node) = current.as_mut() {
                let (k, v) = split_kv(line.trim()).ok_or_else(|| format!("bad node line: {line}"))?;
                match k {
                    "name" => node.name = v,
                    "kind" => node.kind = v,
                    "bot" => node.bot_profile = v,
                    "model" => node.model = v,
                    "status" => node.status = v,
                    "latency_ms" => node.latency_ms = v.parse().unwrap_or(0),
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
    Ok((id, name, status, paused, triggers, nodes))
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
        let yaml = emit("wf_market", "Morning", "paused_editable", Some("node_1"), &triggers, &nodes);
        let (_id, _name, status, paused, trig, parsed) = parse(&yaml).unwrap();
        assert_eq!(status, "paused_editable");
        assert_eq!(paused.as_deref(), Some("node_1"));
        assert_eq!(trig, triggers);
        assert_eq!(parsed[0].prompt, "Extract catalysts: top 5");
        assert_eq!(parsed[0].latency_ms, 12);
    }
}
