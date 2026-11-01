//! Co-worker upgrade wired into the real turn loop in `agent.rs`.
//!
//! - `PROTOCOL` — how every bot answers: outcome first, do the work, no fluff.
//! - `pre_flight` — lessons from EXPERIENCE.md plus the project folder and git state.
//! - `action_signature` / `tool_failed` — identical failing calls are blocked on the third try.
//! - `pivot_for` — on a real failure, names the next approach (environment, browser, a different plan, or stop for a person). It does not invent a successful run.
//! - `compile_contract` — a short definition of done taken from an imperative request. The turn cannot sign off until those checks actually succeeded.
//! - `save_workflow` / `normalize_schedule` — a finished task can be stored as a real workflow, and this chat can be armed on the existing job clock.
//! - `record_lesson` — recovery notes persist in `~/.ronicos/bots/<id>/library/EXPERIENCE.md`.

use crate::models::WfNode;
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const PROTOCOL: &str = "Co-worker protocol (binding):\n1. Outcome first. For actionable tasks requiring tools, Sentence 1 states what you actually did and what a tool verified. For conversational greetings, simple questions, or conceptual explanations, reply directly and conversationally without running unneeded tools. Never open with \"Certainly!\", \"I'd be happy to help\", or \"Here is how you can\".\n2. Action over advice. If the task can be done with your tools, do it and then report the result. For pure informational queries, explanations, or conversational greetings, provide the answer directly.\n3. On a tool error, follow the Pivot line in the tool result. Change approach. Do not paste a long stack trace into the chat. One sentence: what failed, what you did instead, and the verified result.\n4. Never repeat an identical failed call. The third identical failure is blocked. Never claim success while the definition of done is still open or the last action failed.\n5. Your mini computer is a real desktop: Files (your workspace + memory library), Chrome (tabbed, isolated profile), and Terminal (a live shell rooted at your workspace — terminal_write reaches that same session by default). computer_shell switches apps and tabs: open_app \"terminal\" to run shell work visibly, \"files\" to check your workspace, back to \"chrome\" when done. Browser tools act on the active Chrome tab; controls come back numbered, like [12] button Add to cart, and hidden or off-screen junk is already filtered out. click_control and type_text take an id; click_control also takes match: \"button text\" to pick and click the best visible match itself (it reports what it clicked). find_control ranks matches best-first. scroll_page reaches below the fold. After a click that opens or loads something, call wait_for once (query: \"next page text\", or media: \"playing\" for video) instead of re-reading in a loop. Do not guess pixel coordinates.\n6. Logins and forms: when a task needs a sign-in, fill the fields with credentials the user already gave in this chat. If none were provided, ask the user for them in one short message and stop that turn; never guess or invent passwords. After signing in, verify with read_page (the page shows the account or dashboard) before continuing.\n7. When the user wants a workflow, call save_workflow. When they want this chat to repeat on a timer, call schedule_routine. A workflow is saved idle until a person presses Run. A schedule runs only while Ronic OS is open.\n8. When a finished task took several steps, close with one short offer to save it as a workflow or schedule this chat.\n9. Expert craft (highest priority): answer like a senior specialist in the user's domain. Think and plan before building: state a short plan (2-4 bullets) for any multi-step build, then execute it step by step. Ask at most one targeted clarifying question when the request is genuinely ambiguous; otherwise act on the most reasonable interpretation and say which one. Stay strictly on the user's actual request — no tangents, no generic filler, no restating the question back. If you do not know a fact, say so in one line instead of guessing. Match the user's vocabulary: mirror the concrete nouns and tool names they used. For funnels, workflows, and builds, name real platforms, real fields, and real next actions — never vague placeholders like \"integrate with your CRM\"; say which CRM fields map where. When you produce a plan, it must be concrete enough that the user could hand it to a contractor unchanged.\n10. Structured output: Format technical plans, code, and structured answers cleanly using Markdown headers, lists, and tables where applicable. For casual conversation or simple answers, respond naturally without forcing artificial tables or headers.\n11. Autonomous execution: In Auto Approve mode for actionable tasks, research, plan, and build decisively without asking unnecessary questions. For conversational messages or simple questions, respond directly to the user.";

/// Stable signature of one tool invocation: same tool + same normalized
/// arguments = same signature, regardless of JSON key order.
pub fn action_signature(tool: &str, args: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}::{}", tool.trim(), canonicalize(args)));
    format!("{:x}", hasher.finalize())
}

fn canonicalize(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let inner = entries.into_iter().map(|(k, v)| format!("{k}:{}", canonicalize(v))).collect::<Vec<_>>().join(",");
            format!("{{{inner}}}")
        }
        Value::Array(items) => {
            let inner = items.iter().map(canonicalize).collect::<Vec<_>>().join(",");
            format!("[{inner}]")
        }
        other => other.to_string(),
    }
}

/// Conservative failure detection: a terminal command with a non-zero exit
/// code, or a refusal emitted by the tool layer itself (these start the
/// output string). Tool *output* that merely contains the word "error" does
/// not count, so a successful grep or log read is never mistaken for one.
/// A successful browser read, diff, workflow save, or schedule is never a failure.
pub fn tool_failed(action: &str, payload: &Value, output: &str) -> bool {
    if matches!(action, "workflow" | "routine" | "code_diff" | "browser_inspect") {
        return false;
    }
    if action == "pty_terminal" || action == "sandbox_output" {
        if let Some(code) = payload.get("exitCode").and_then(|v| v.as_i64()) {
            return code != 0;
        }
    }
    let lower = output.trim_start().to_ascii_lowercase();
    const STARTS: &[&str] = &[
        "error",
        "failed",
        "blocked",
        "no such file",
        "refused",
        "could not",
        "that control is not",
        "that local server",
        "fetch failed",
        "terminal write failed",
        "pipes, redirects",
        "empty command",
        "that tool is off",
        "file write is off",
        "that computer belongs",
        "main window is not",
        "this computer is not",
        "inspect_page needs",
    ];
    if STARTS.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }
    (lower.starts_with('\'') && lower.contains("is not on the allowed"))
        || lower.contains("is not available for this profile")
        || lower.contains("the gateway held this action")
}

/// Which automation surfaces this bot is allowed to use. The pivot ladder
/// will not tell the model to open a browser or write a file when that
/// surface is off.
#[derive(Clone, Copy)]
pub struct Surfaces {
    pub computer: bool,
    pub browser: bool,
    pub files: bool,
}

/// The next approach after a real failure. `stop` means a person has to act
/// (a code, an approval, a tool that is switched off, or too many dead ends).
/// The headline is what the chat shows. The directive is what the model must follow.
#[derive(Clone, Debug)]
pub struct Pivot {
    pub tier: u8,
    pub headline: String,
    pub directive: String,
    pub stop: bool,
}

/// Choose the next approach from the actual error text.
/// `identical` is how many times this exact call has failed, including this one.
/// `distinct` is how many different failing calls this turn has already seen.
pub fn pivot_for(tool: &str, output: &str, identical: u32, distinct: u32, surfaces: Surfaces) -> Pivot {
    let kind = obstacle(tool, output);
    if kind == "human" {
        return make_pivot(5, true, "Needs a person before this can continue.", "Stop calling tools. Say what needs a code, an approval, or a takeover. Do not claim the task is done.");
    }
    if kind == "off" {
        return make_pivot(5, true, "This tool is off for the bot.", "Stop calling tools. Tell the user which tool is off. Do not pretend another surface ran.");
    }
    if distinct >= 4 {
        return make_pivot(4, true, "Stopped after several failed approaches.", "Stop calling tools. In one sentence say the blocker, name the approaches you already tried, and the single next step a person can take. Do not claim the task is done.");
    }
    if identical >= 3 {
        return make_pivot(3, false, "Identical retry blocked.", "This exact call already failed twice, so it was not run again. Use a different tool or different arguments. One new approach only. Do not claim the task is done.");
    }
    if distinct >= 3 {
        return make_pivot(3, false, "Three approaches failed.", "Do not repeat a call that already failed. Pick one surface you have not used yet and try it once. Then either verify the result or say what is still blocked.");
    }
    match kind {
        "http" if surfaces.browser && !browser_tool(tool) => {
            make_pivot(2, false, "Fetch blocked. Next is the bot browser.", "Open the page with inspect_page. Use click_control or type_text only with an id from that numbered list. Read the page again after a click. Do not repeat the failed fetch.")
        }
        "http" if browser_tool(tool) => {
            make_pivot(2, false, "Page read failed.", "Check the address: https, or http on localhost. If this host refused the connection, say so. Do not retry the same address with the same tool.")
        }
        "http" => make_pivot(1, false, "Fetch blocked and browser use is off.", "Browser use is off for this bot, so do not pretend you opened a page. Use a local file or an allowlisted command only when that can actually finish the task. Otherwise say the fetch was blocked."),
        "control" if surfaces.browser => {
            make_pivot(2, false, "That control id is stale.", "Call read_page and use an id from the new numbered list. Do not reuse the old id and do not guess coordinates.")
        }
        "missing" => make_pivot(1, false, "Command is missing or not allowed.", "Use one allowlisted program already expected on this machine: git, npm, bun, cargo, python, uv, or pytest. Do not chain commands with pipes or &&. Do not repeat this exact call."),
        "chain" => make_pivot(1, false, "Shell chaining is blocked.", "Run one allowlisted command, read the result, then run the next command as its own call."),
        _ if surfaces.files && tool != "propose_diff" => {
            make_pivot(1, false, "Command failed. Fix the cause, then check again.", "Read the error. If a file is wrong, call propose_diff. The file is not written until the person accepts the diff. Then run a different check. Do not repeat this exact command.")
        }
        _ => make_pivot(1, false, "This attempt failed.", "Change the arguments or the tool. Do not repeat this exact call. If you cannot finish, say what failed and what you already tried."),
    }
}

fn make_pivot(tier: u8, stop: bool, headline_body: &str, directive: &str) -> Pivot {
    let headline = format!("Pivot · Tier {tier} · {headline_body}");
    Pivot {
        tier,
        headline: headline.clone(),
        directive: format!("{headline}\n{directive}"),
        stop,
    }
}

fn browser_tool(tool: &str) -> bool {
    matches!(tool, "inspect_page" | "read_page" | "click_control" | "type_text" | "scroll_page" | "find_control" | "wait_for")
}

fn obstacle(tool: &str, output: &str) -> &'static str {
    let lower = output.to_ascii_lowercase();
    if human_block(&lower) {
        return "human";
    }
    if lower.starts_with("that tool is off") || lower.starts_with("file write is off") || lower.contains("belongs to another bot") {
        return "off";
    }
    if lower.contains("is not on the allowed")
        || lower.contains("not recognized")
        || lower.contains("not found")
        || lower.starts_with("no such file")
        || lower.contains("cannot find the path")
    {
        return "missing";
    }
    if lower.contains("pipes, redirects") {
        return "chain";
    }
    if lower.contains("that control is not") || lower.contains("could not click") || lower.contains("could not type") {
        return "control";
    }
    if lower.contains("http 401") || lower.contains("http 403") || lower.contains("http 429") || lower.contains("cloudflare") || lower.contains("fetch failed") || lower.contains("too many requests") {
        return "http";
    }
    if browser_tool(tool) && (lower.contains("not running") || lower.starts_with("could not")) {
        return "control";
    }
    "command"
}

fn human_block(lower: &str) -> bool {
    const MARKS: &[&str] = &[
        "captcha",
        "2fa",
        "two-factor",
        "one-time code",
        "one time code",
        "otp",
        "approve spend",
        "the gateway held",
        "pending_approval",
        "held for your approval",
        "killswitch",
    ];
    MARKS.iter().any(|mark| lower.contains(mark))
}

/// Machine-checkable outcomes for one imperative request. Questions and
/// explanations produce an empty contract so the bot can just answer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Proof {
    CommandOk,
    FileProposed,
    PageWorked,
    WorkflowSaved,
    RoutineScheduled,
}

#[derive(Clone, Debug, Default)]
pub struct Contract {
    pub checks: Vec<Proof>,
}

impl Contract {
    pub fn requirement_line(&self) -> Option<String> {
        if self.checks.is_empty() {
            return None;
        }
        let lines = self.checks.iter().map(|check| format!("- {}", proof_label(*check))).collect::<Vec<_>>().join("\n");
        Some(lines)
    }

    pub fn unmet(&self, have: &[Proof]) -> Option<String> {
        let missing: Vec<&str> = self.checks.iter().filter(|check| !have.contains(check)).map(|check| proof_label(*check)).collect();
        if missing.is_empty() {
            None
        } else {
            Some(missing.join("; "))
        }
    }
}

pub fn proof_label(proof: Proof) -> &'static str {
    match proof {
        Proof::CommandOk => "a command that exits 0",
        Proof::FileProposed => "a proposed file diff",
        Proof::PageWorked => "a browser read, click, or type that succeeded",
        Proof::WorkflowSaved => "a workflow saved on the Workflows screen",
        Proof::RoutineScheduled => "a schedule on this chat",
    }
}

pub fn is_greeting(lower: &str) -> bool {
    const GREETINGS: &[&str] = &[
        "hi", "hello", "hey", "howdy", "sup", "what's up", "whats up",
        "good morning", "good afternoon", "good evening", "good night",
        "yo", "greetings"
    ];
    let trimmed = lower.trim().trim_end_matches(['!', '?', '.', ',', ' ']);
    GREETINGS.iter().any(|g| {
        trimmed == *g
            || trimmed.starts_with(&format!("{g} "))
            || trimmed.starts_with(&format!("{g},"))
            || trimmed.starts_with(&format!("{g}!"))
    })
}

/// Pull a definition of done out of an imperative request. The attached-file
/// block is ignored so a pasted log cannot invent extra checks.
pub fn compile_contract(prompt: &str) -> Contract {
    let clean = crate::agent::strip_directives(prompt);
    let head = clean.split("\n\nAttached files:").next().unwrap_or(&clean).split("\nAttached files:").next().unwrap_or(&clean);
    let lower = head.trim().to_ascii_lowercase();
    if lower.is_empty() || is_greeting(&lower) || question_only(&lower) || !asks_for_work(&lower) {
        return Contract::default();
    }
    let mut checks = Vec::new();
    if wants_schedule(&lower) {
        checks.push(Proof::RoutineScheduled);
    }
    if wants_workflow(&lower) {
        checks.push(Proof::WorkflowSaved);
    }
    if wants_command(&lower) {
        checks.push(Proof::CommandOk);
    }
    if wants_edit(&lower) {
        checks.push(Proof::FileProposed);
    }
    if wants_page(&lower) {
        checks.push(Proof::PageWorked);
    }
    checks.truncate(4);
    Contract { checks }
}

pub fn question_only(lower: &str) -> bool {
    let trimmed = lower.trim_start();
    const STARTERS: &[&str] = &["what ", "why ", "who ", "when ", "where ", "how ", "explain ", "describe ", "tell me ", "define "];
    if !STARTERS.iter().any(|starter| trimmed.starts_with(starter)) {
        return false;
    }
    // "How do I run tests?" mentions work but asks for an explanation. Only an
    // explicit imperative marker ("please", "go ahead", ...) turns it into work.
    const IMPERATIVE: &[&str] = &["please", "go ahead", "i need you", "i want you", "for me"];
    !IMPERATIVE.iter().any(|mark| lower.contains(mark))
}

pub fn asks_for_work(lower: &str) -> bool {
    const MARKS: &[&str] = &[
        "please",
        "can you",
        "could you",
        "would you",
        "i need you",
        "i want you",
        "go ahead",
        "run ",
        "fix ",
        "create ",
        "set up",
        "setup ",
        "schedule",
        "automate",
        "click ",
        "open ",
        "build ",
        "install ",
        "write ",
        "update ",
        "edit ",
        "patch ",
        "implement",
        "verify ",
        "scrape",
        "save this",
        "save it",
        "make a",
        "make the",
        "add a ",
        "add the ",
        "change the",
        "change this",
        "check the",
        "check that",
        "rerun",
        "re-run",
    ];
    MARKS.iter().any(|mark| lower.contains(mark))
}

fn wants_schedule(lower: &str) -> bool {
    const MARKS: &[&str] = &["schedule", "every day", "daily", "cron", "every hour", "every morning", "every 15", "repeat this", "recurring"];
    MARKS.iter().any(|mark| lower.contains(mark))
}

fn wants_workflow(lower: &str) -> bool {
    const MARKS: &[&str] = &["workflow", "pipeline", "automate this", "automate it", "save this as", "save it as"];
    MARKS.iter().any(|mark| lower.contains(mark))
}

/// Whole-word substring match, so "testing" does not count as "test".
fn has_word(lower: &str, word: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut start = 0;
    while let Some(pos) = lower[start..].find(word) {
        let at = start + pos;
        let end = at + word.len();
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        let after_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = end;
    }
    false
}

fn wants_command(lower: &str) -> bool {
    const SPECIFIC: &[&str] = &["tests", "pytest", "vitest", "cargo", "npm ", "pnpm ", "bun ", "typecheck", " tsc", "compile", "lint"];
    if SPECIFIC.iter().any(|mark| lower.contains(mark)) {
        return true;
    }
    if has_word(lower, "test") {
        return true;
    }
    lower.contains("build") && !lower.contains("workflow")
}

fn wants_edit(lower: &str) -> bool {
    if lower.contains("workflow") && !lower.contains("file") && !lower.contains("bug") {
        return false;
    }
    const VERBS: &[&str] = &["fix ", "patch ", "edit ", "rewrite", "implement", "update the", "update this", "change the", "change this", "write the", "write a ", "add a ", "add the "];
    const NOUNS: &[&str] = &["bug", "file", "code", "function", "component", "readme", ".rs", ".ts", ".tsx", ".py", ".css", "error"];
    VERBS.iter().any(|verb| lower.contains(verb)) && (NOUNS.iter().any(|noun| lower.contains(noun)) || has_word(lower, "test"))
}

fn wants_page(lower: &str) -> bool {
    const MARKS: &[&str] = &["http://", "https://", "website", "web page", "browser", "click ", "scrape", "inspect the page", "open the page", "log in", "login"];
    MARKS.iter().any(|mark| lower.contains(mark))
}

/// Record a real tool success against the definition of done.
pub fn proof_of(tool: &str, payload: &Value, failed: bool) -> Option<Proof> {
    if failed {
        return None;
    }
    match tool {
        "terminal_command" | "sandbox_command" | "run_command" | "execute_command" => {
            let code = payload.get("exitCode").and_then(|value| value.as_i64()).unwrap_or(1);
            if code == 0 { Some(Proof::CommandOk) } else { None }
        }
        "propose_diff" => Some(Proof::FileProposed),
        "inspect_page" | "read_page" | "click_control" | "type_text" | "scroll_page" | "find_control" | "wait_for" => Some(Proof::PageWorked),
        "save_workflow" => Some(Proof::WorkflowSaved),
        "schedule_routine" => Some(Proof::RoutineScheduled),
        _ => None,
    }
}

/// Turn a person's words into a schedule the job clock already understands.
/// Daily cron (`0 8 * * *`) becomes `daily HH:MM`. Anything else returns None.
pub fn normalize_schedule(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    if let Some(cron) = lower.strip_prefix("cron:") {
        return normalize_schedule(cron);
    }
    if let Some(parts) = cron_daily(&lower) {
        return Some(parts);
    }
    if let Some(captured) = regex_every(&lower) {
        return Some(captured);
    }
    if let Some(captured) = regex_daily(&lower) {
        return Some(captured);
    }
    if let Some(captured) = regex_legacy_daily(&lower) {
        return Some(captured);
    }
    None
}

fn cron_daily(text: &str) -> Option<String> {
    let bits: Vec<&str> = text.split_whitespace().collect();
    if bits.len() != 5 || bits[2] != "*" || bits[3] != "*" || bits[4] != "*" {
        return None;
    }
    let minute: u32 = bits[0].parse().ok()?;
    let hour: u32 = bits[1].parse().ok()?;
    if minute > 59 || hour > 23 {
        return None;
    }
    Some(format!("daily {hour:02}:{minute:02}"))
}

fn regex_every(text: &str) -> Option<String> {
    let rest = text.strip_prefix("every ")?.trim();
    let count_end = rest.find(|ch: char| !ch.is_ascii_digit())?;
    if count_end == 0 {
        return None;
    }
    let count: u32 = rest[..count_end].parse().ok()?;
    if count < 1 || count > 24 * 14 {
        return None;
    }
    let unit = rest[count_end..].trim();
    let unit = unit.split_whitespace().next().unwrap_or("").trim_end_matches('s');
    if matches!(unit, "m" | "min" | "minute") {
        return Some(format!("every {count}m"));
    }
    if matches!(unit, "h" | "hr" | "hour") {
        return Some(format!("every {count}h"));
    }
    None
}

fn regex_daily(text: &str) -> Option<String> {
    let rest = text.strip_prefix("daily ")?.trim();
    let (hour_raw, minute_raw) = rest.split_once(':')?;
    if minute_raw.len() != 2 || !minute_raw.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let hour: u32 = hour_raw.parse().ok()?;
    let minute: u32 = minute_raw.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(format!("daily {hour:02}:{minute:02}"))
}

fn regex_legacy_daily(text: &str) -> Option<String> {
    let rest = text.strip_prefix("every day at ")?.trim();
    let mut bits = rest.split_whitespace();
    let clock = bits.next()?;
    let suffix = bits.next()?;
    if bits.next().is_some() || (suffix != "am" && suffix != "pm") {
        return None;
    }
    let (hour_raw, minute_raw) = match clock.split_once(':') {
        Some((hour, minute)) => (hour, minute),
        None => (clock, "0"),
    };
    let mut hour: u32 = hour_raw.parse().ok()?;
    let minute: u32 = minute_raw.parse().ok()?;
    if !(1..=12).contains(&hour) || minute > 59 {
        return None;
    }
    if suffix == "pm" && hour < 12 {
        hour += 12;
    }
    if suffix == "am" && hour == 12 {
        hour = 0;
    }
    Some(format!("daily {hour:02}:{minute:02}"))
}

pub struct PlannedWorkflow {
    pub name: String,
    pub nodes: Vec<WfNode>,
    pub triggers: Vec<String>,
    pub note: String,
}

/// Build the workflow the Workflows screen can run. Does not start it.
pub fn plan_workflow(name: &str, steps_text: &str, schedule: &str) -> Result<PlannedWorkflow, String> {
    let name = clip_line(name, 80);
    if name.is_empty() {
        return Err("save_workflow needs a name".into());
    }
    let mut nodes = Vec::new();
    for (index, line) in steps_text.lines().map(str::trim).filter(|line| !line.is_empty()).take(8).enumerate() {
        let (step_name, prompt) = match line.split_once('|') {
            Some((left, right)) => {
                let step_name = clip_line(left, 60);
                let prompt = clip_line(right, 500);
                let step_name = if step_name.is_empty() { format!("Step {}", index + 1) } else { step_name };
                if prompt.is_empty() {
                    return Err(format!("step {} has a title but no instruction", index + 1));
                }
                (step_name, prompt)
            }
            None => (format!("Step {}", index + 1), clip_line(line, 500)),
        };
        let kind = if prompt.to_ascii_lowercase().contains("approv") { "approval_gate" } else { "llm_reasoning" };
        nodes.push(WfNode {
            id: format!("node_{}", index + 1),
            name: step_name,
            kind: kind.into(),
            bot_profile: String::new(),
            model: String::new(),
            prompt,
            status: "pending".into(),
            latency_ms: 0,
        });
    }
    if nodes.is_empty() {
        return Err("save_workflow needs at least one step".into());
    }
    let schedule = schedule.trim();
    let (triggers, note) = if schedule.is_empty() {
        (Vec::new(), "It is idle until a person presses Run on the Workflows screen.".to_string())
    } else {
        let normalized = normalize_schedule(schedule).ok_or_else(|| {
            "That schedule is not one this app can store. Use daily HH:MM, every 15m, every 1h, or a daily cron like 0 8 * * *.".to_string()
        })?;
        (
            vec![normalized.clone()],
            format!("Trigger noted as \"{normalized}\". The workflow stays idle until Run. To repeat this chat on that timer, also call schedule_routine."),
        )
    };
    Ok(PlannedWorkflow { name, nodes, triggers, note })
}

fn clip_line(raw: &str, max_chars: usize) -> String {
    let flat = raw.replace(['\n', '\r'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(max_chars).collect::<String>().trim().to_string()
}

/// Write a workflow row and `~/.ronicos/workflows/<id>.workflow.yaml`.
/// The row is idle. Nothing runs until a person presses Run.
pub fn save_workflow(conn: &Connection, home: &Path, name: &str, steps_text: &str, schedule: &str) -> Result<String, String> {
    let planned = plan_workflow(name, steps_text, schedule)?;
    let id = crate::util::nid("wf");
    let yaml = crate::yaml_flow::emit(&id, &planned.name, "idle", None, &planned.triggers, &planned.nodes);
    let dir = home.join("workflows");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let safe = crate::util::safe_id_component(&id).map_err(|error| error.0)?;
    std::fs::write(dir.join(format!("{safe}.workflow.yaml")), &yaml).map_err(|error| error.to_string())?;
    let nodes_json = serde_json::to_string(&planned.nodes).map_err(|error| error.to_string())?;
    let triggers_json = serde_json::to_string(&planned.triggers).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO workflows (id, name, yaml_source, nodes_json, triggers_json, current_status, paused_at_node_id, checkpoint_json, updated_at) VALUES (?1,?2,?3,?4,?5,'idle',NULL,'{}',?6)",
        params![id, planned.name, yaml, nodes_json, triggers_json, crate::util::now_ms()],
    )
    .map_err(|error| error.to_string())?;
    Ok(format!(
        "Saved workflow \"{}\" ({id}) with {} step(s) on the Workflows screen. {}",
        planned.name,
        planned.nodes.len(),
        planned.note
    ))
}

fn experience_path(home: &Path, bot_id: &str) -> std::path::PathBuf {
    home.join("bots").join(bot_id).join("library").join("EXPERIENCE.md")
}

/// Read the most recent lessons for a bot (tail of EXPERIENCE.md), capped so
/// the system prompt stays small. Empty when the file does not exist yet.
pub fn lessons(home: &Path, bot_id: &str, max_chars: usize) -> String {
    let text = std::fs::read_to_string(experience_path(home, bot_id)).unwrap_or_default();
    let lesson_lines: Vec<&str> = text.lines().filter(|line| line.starts_with("- ")).collect();
    if lesson_lines.is_empty() {
        return String::new();
    }
    // Newest lessons live at the end — keep the tail within the budget.
    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0usize;
    for line in lesson_lines.iter().rev() {
        let len = line.len() + 1;
        if used + len > max_chars && !kept.is_empty() {
            break;
        }
        kept.push(line);
        used += len;
    }
    kept.reverse();
    kept.join("\n")
}

/// Append one recovery lesson. Kept intentionally short and dated; the file
/// is trimmed from the front if it grows past a screenful.
pub fn record_lesson(home: &Path, bot_id: &str, lesson: &str) {
    let lesson = lesson.trim();
    if lesson.is_empty() {
        return;
    }
    let path = experience_path(home, bot_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    if text.is_empty() {
        text.push_str("# Experience\n\nLessons the bot learned from recovered failures. Read before similar tasks.\n\n");
    }
    text.push_str(&format!("- {} · {}\n", today(), lesson));
    // Cap at roughly 40 entries: drop oldest lines beyond the header.
    let lines: Vec<&str> = text.lines().collect();
    let header_end = lines.iter().position(|line| line.starts_with("- ")).unwrap_or(lines.len());
    let entries = &lines[header_end..];
    if entries.len() > 40 {
        let kept = &entries[entries.len() - 40..];
        let mut out = String::new();
        out.extend(lines[..header_end].iter().map(|line| format!("{line}\n")));
        out.extend(kept.iter().map(|line| format!("{line}\n")));
        text = out;
    }
    let _ = std::fs::write(&path, text);
}

/// Silent pre-flight: recovery lessons, the project folder, and git state.
/// Missing pieces are skipped. This never asks the user a question.
pub fn pre_flight(home: &Path, bot_id: &str, project_root: &str) -> String {
    let mut parts = Vec::new();
    let learned = lessons(home, bot_id, 1200);
    if !learned.is_empty() {
        parts.push(format!("Lessons from this bot's previous runs:\n{learned}"));
    }
    let root = project_root.trim();
    if !root.is_empty() && Path::new(root).is_dir() {
        parts.push(format!("Project folder: {root}"));
        let git = git_snapshot(root);
        if !git.is_empty() {
            parts.push(format!("Workspace git state right now:\n{git}"));
        }
    }
    parts.join("\n\n")
}

fn git_snapshot(root: &str) -> String {
    let root = root.trim();
    if root.is_empty() || !Path::new(root).is_dir() {
        return String::new();
    }
    match crate::util::run_capture("git", &["status", "--porcelain", "-b"], Some(Path::new(root)), std::time::Duration::from_secs(2)) {
        Ok((0, out)) if !out.trim().is_empty() => out.lines().take(8).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn today() -> String {
    let now = now_unix();
    let days = now.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signature_ignores_key_order_and_whitespace() {
        let a = action_signature("terminal_command", &json!({"command": "cargo test", "cwd": "."}));
        let b = action_signature("terminal_command ", &json!({"cwd": ".", "command": "cargo test"}));
        assert_eq!(a, b);
        let c = action_signature("terminal_command", &json!({"command": "cargo check", "cwd": "."}));
        assert_ne!(a, c);
    }

    #[test]
    fn failure_detection_is_conservative() {
        assert!(tool_failed("pty_terminal", &json!({"exitCode": 1}), "$ cargo test\nexit 1\nerror: test failed"));
        assert!(!tool_failed("pty_terminal", &json!({"exitCode": 0}), "warning: unused import\nexit 0"));
        assert!(tool_failed("message", &json!({}), "'python' is not on the allowed terminal tools list"));
        assert!(tool_failed("message", &json!({}), "Error: provider unreachable"));
        // Successful tool output that merely mentions the word error is NOT a failure.
        assert!(!tool_failed("read_file", &json!({}), "line 4: error handling added\nline 5: ok"));
    }

    #[test]
    fn lessons_round_trip_and_trim() {
        let home = std::env::temp_dir().join(format!("ronic-cow-{}-{}", std::process::id(), now_unix()));
        let _ = std::fs::remove_dir_all(&home);
        record_lesson(&home, "bot_x", "terminal_command 'npm test' failed twice; pivoted to bun test and passed.");
        record_lesson(&home, "bot_x", "HTTP 403 on scrape; pivoted to browser DOM read.");
        let text = lessons(&home, "bot_x", 4000);
        assert!(text.contains("bun test"));
        assert!(text.contains("403"));
        assert_eq!(text.lines().count(), 2);
        // Tail capping keeps the most recent lessons and drops the oldest.
        let short = lessons(&home, "bot_x", 60);
        assert!(!short.contains("bun test"), "old lesson should be dropped: {short}");
        assert!(short.contains("403"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn pre_flight_skips_silently_when_nothing_exists() {
        let home = std::env::temp_dir().join(format!("ronic-cow-pf-{}", now_unix()));
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(pre_flight(&home, "bot_none", ""), "");
        assert_eq!(pre_flight(&home, "bot_none", "Z:\\definitely\\missing"), "");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn surfaces() -> Surfaces {
        Surfaces { computer: true, browser: true, files: true }
    }

    #[test]
    fn http_block_pivots_to_the_browser_when_browser_is_on() {
        let pivot = pivot_for("terminal_command", "curl: HTTP 403 cloudflare", 1, 1, surfaces());
        assert_eq!(pivot.tier, 2);
        assert!(!pivot.stop);
        assert!(pivot.directive.contains("inspect_page"));
        assert!(pivot.headline.starts_with("Pivot · Tier 2"));
    }

    #[test]
    fn http_block_does_not_invent_a_browser_when_browser_is_off() {
        let pivot = pivot_for(
            "terminal_command",
            "HTTP 403",
            1,
            1,
            Surfaces { computer: true, browser: false, files: true },
        );
        assert_eq!(pivot.tier, 1);
        assert!(pivot.directive.to_ascii_lowercase().contains("browser use is off"));
        assert!(!pivot.directive.contains("inspect_page"));
    }

    #[test]
    fn third_identical_failure_is_blocked_without_claiming_success() {
        let pivot = pivot_for("terminal_command", "exit 1\nerror: test failed", 3, 1, surfaces());
        assert_eq!(pivot.tier, 3);
        assert!(!pivot.stop);
        assert!(pivot.headline.contains("Identical retry blocked"));
        assert!(!pivot.directive.to_ascii_lowercase().contains("completed"));
    }

    #[test]
    fn four_different_failures_stop_for_a_report() {
        let pivot = pivot_for("terminal_command", "exit 1", 1, 4, surfaces());
        assert_eq!(pivot.tier, 4);
        assert!(pivot.stop);
        assert!(pivot.directive.contains("Stop calling tools"));
    }

    #[test]
    fn captcha_and_disabled_tool_stop_for_a_person() {
        let captcha = pivot_for("inspect_page", "Error: captcha required", 1, 1, surfaces());
        assert!(captcha.stop);
        assert_eq!(captcha.tier, 5);
        let off = pivot_for("terminal_command", "That tool is off for this bot.", 1, 1, surfaces());
        assert!(off.stop);
        assert!(off.headline.contains("tool is off"));
    }

    #[test]
    fn stale_control_asks_for_a_fresh_page_read() {
        let pivot = pivot_for("click_control", "that control is not on this page", 1, 1, surfaces());
        assert_eq!(pivot.tier, 2);
        assert!(pivot.directive.contains("read_page"));
    }

    #[test]
    fn contract_tracks_imperative_work_and_skips_questions() {
        let work = compile_contract("Please run the tests, fix the bug in auth.ts, and set up a daily workflow.");
        assert!(work.checks.contains(&Proof::CommandOk));
        assert!(work.checks.contains(&Proof::FileProposed));
        assert!(work.checks.contains(&Proof::WorkflowSaved));
        assert!(work.checks.contains(&Proof::RoutineScheduled));
        assert!(work.unmet(&[Proof::CommandOk]).unwrap().contains("file diff"));
        assert!(work
            .unmet(&[Proof::CommandOk, Proof::FileProposed, Proof::WorkflowSaved, Proof::RoutineScheduled])
            .is_none());
        assert!(compile_contract("What is a workflow?").checks.is_empty());
        assert!(compile_contract("Explain how git status works.").checks.is_empty());
        assert!(compile_contract("hey buddy, what's up").checks.is_empty());
        assert!(compile_contract("hello! how are you doing?").checks.is_empty());
        assert!(compile_contract("hey buddy, what's up\n\n[APPROVAL MODE: AUTO APPROVE (Autonomous). Research, think, plan, and start building immediately.]").checks.is_empty());
    }

    #[test]
    fn how_question_without_imperative_stays_a_question() {
        assert!(compile_contract("How do I run the tests in this project?").checks.is_empty());
        let work = compile_contract("How do I run the tests in this project? Please run them for me.");
        assert!(work.checks.contains(&Proof::CommandOk));
    }

    #[test]
    fn haiku_request_does_not_demand_code_proof() {
        assert!(compile_contract("Please write a haiku about testing.").checks.is_empty());
    }

    #[test]
    fn page_task_requires_a_real_browser_success() {
        let contract = compile_contract("Can you open the page https://example.com and click the login button?");
        assert_eq!(contract.checks, vec![Proof::PageWorked]);
        assert!(proof_of("click_control", &json!({}), false).is_some());
        assert!(proof_of("click_control", &json!({}), true).is_none());
        assert_eq!(proof_of("terminal_command", &json!({"exitCode": 0}), false), Some(Proof::CommandOk));
        assert!(proof_of("terminal_command", &json!({"exitCode": 1}), false).is_none());
    }

    #[test]
    fn schedules_match_the_job_clock() {
        assert_eq!(normalize_schedule("0 8 * * *").as_deref(), Some("daily 08:00"));
        assert_eq!(normalize_schedule("cron: 30 14 * * *").as_deref(), Some("daily 14:30"));
        assert_eq!(normalize_schedule("every 15 minutes").as_deref(), Some("every 15m"));
        assert_eq!(normalize_schedule("every 1 hour").as_deref(), Some("every 1h"));
        assert_eq!(normalize_schedule("every day at 8:00 AM").as_deref(), Some("daily 08:00"));
        assert_eq!(normalize_schedule("daily 08:00").as_deref(), Some("daily 08:00"));
        assert!(normalize_schedule("0 8 * * 1").is_none());
        assert!(normalize_schedule("whenever").is_none());
    }

    #[test]
    fn planned_workflow_is_idle_and_parseable() {
        let planned = plan_workflow(
            "Morning check",
            "Read the build | Run bun test and report failures\nApprove the result | Wait for approval before publishing",
            "0 8 * * *",
        )
        .unwrap();
        assert_eq!(planned.triggers, vec!["daily 08:00".to_string()]);
        assert_eq!(planned.nodes.len(), 2);
        assert_eq!(planned.nodes[1].kind, "approval_gate");
        assert_eq!(planned.nodes[0].status, "pending");
        let yaml = crate::yaml_flow::emit("wf_test", &planned.name, "idle", None, &planned.triggers, &planned.nodes);
        let parsed = crate::yaml_flow::parse(&yaml).unwrap();
        assert_eq!(parsed.2, "idle");
        assert_eq!(parsed.4, vec!["daily 08:00".to_string()]);
        assert!(parsed.5[0].prompt.contains("bun test"));
    }

    #[test]
    fn save_workflow_writes_a_row_and_a_file() {
        let home = std::env::temp_dir().join(format!("ronic-cow-wf-{}", now_unix()));
        let _ = std::fs::remove_dir_all(&home);
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE workflows (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                yaml_source TEXT NOT NULL,
                nodes_json TEXT NOT NULL,
                triggers_json TEXT NOT NULL DEFAULT '[]',
                current_status TEXT NOT NULL DEFAULT 'idle',
                paused_at_node_id TEXT,
                checkpoint_json TEXT NOT NULL DEFAULT '{}',
                updated_at INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();
        let note = save_workflow(&conn, &home, "Daily tests", "Run the suite | cargo test --lib", "").unwrap();
        assert!(note.contains("Workflows screen"));
        let (status, triggers): (String, String) = conn
            .query_row("SELECT current_status, triggers_json FROM workflows", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!(status, "idle");
        assert_eq!(triggers, "[]");
        let written = std::fs::read_dir(home.join("workflows")).unwrap().next().unwrap().unwrap();
        let body = std::fs::read_to_string(written.path()).unwrap();
        assert!(body.contains("cargo test"));
        assert!(plan_workflow("", "Step", "").is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
