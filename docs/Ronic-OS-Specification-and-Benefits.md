# Ronic OS — Product Specification & Benefits Report

**Version analyzed:** ronicos 2.1.4
**Report date:** 2026-10-30
**Source of truth:** Full codebase analysis (Rust backend ~23k lines, React/TypeScript frontend, Vercel+Supabase cloud control plane, bundled resources)

---

# ⭐ CORE FUNCTIONS (Highlighted)

> These are the five flagship capabilities that define Ronic OS and deliver the most value to the user.

## 🟥 1. Unified Local-First Agent Workstation
**One desktop shell for every AI tool you use.** Ronic OS consolidates coding CLIs, web agents, MCP servers, bot profiles, memory, skills, workflows, and a sandbox wallet into a single Windows desktop application — **with no server-side dependency for the core loop**. Everything runs locally: your chats, your bots, your files, your state. The cloud is only used for licensing, billing, and optional burst compute.

## 🟥 2. Multi-Bot Squads + 3-Pillar Computer-Use Engine
**Run 2–4 AI bots simultaneously, each in its own isolated mini-window.** Each bot gets its own WebView2 profile, virtual cursor HUD, and one of three driver pillars: (1) per-bot floating PiP mini-computer windows with synthetic DOM driving confined to that window, (2) **native Windows UIAutomation** control-tree driving with background `InvokePattern`/`ValuePattern` and `WM_LBUTTONDOWN` posting — the user's real cursor is never touched, and (3) **Set-of-Marks vision grounding** — 960×540 window capture fused with UIA rectangles, numbered badges stamped in Rust, exact `mark_id → pixel center` registry. A shared **Squad Blackboard bus** (`tokio::sync::broadcast`, capacity 256 + SQLite persistence) lets a producer bot stream structured packets directly into consumer bots — **no OS clipboard, no cross-contamination, sub-millisecond coordination**. A process-wide **emergency halt flag** every driver checks can stop all computer use instantly. Squads are a **Pro-licensed** feature.

## 🟥 3. Encrypted Local Vault + Offline License Verification
**Military-grade local security with zero-knowledge architecture.** All API keys and secrets live in `~/.omniworkspace/secrets.vault` encrypted with **AES-256-GCM**; the key is derived from your passphrase with **Argon2id** (19,456 iterations). `lock_vault` drops the key from memory. Licensing uses **Ed25519-signed 7-day offline leases** — the desktop verifies them locally in <0.1ms against a compiled-in public key. Editing the database achieves nothing: the signature covers user_id, tier, hardware_hash, and expiry.

## 🟥 4. Visual Workflow Engine with Human Approval Gates
**Build multi-step bot automations with checkpoints you control.** Workflows are persisted in SQLite + YAML, support up to 8 nodes (LLM reasoning, approval gates, wallet execution, browser automation), and can be scheduled (daily, every 15m/1h, cron). **Any step containing "approve" automatically becomes a human approval gate** — the workflow pauses until you review and resume. Per-node checkpoint JSON enables pause/resume from any point.

## 🟥 5. Policy-Gated Multi-Rail Wallet & Quant Terminal
**A deterministic guardrail the AI can never bypass.** The built-in wallet enforces hard limits — max per-transaction USD, daily spending cap, human-approval-above threshold, max slippage (basis points), and a **kill switch** that blocks all agent/trade actions instantly. Every spend passes `policy::evaluate` in Rust and settles as `auto_signed_by_rust`, `pending_approval` (fail-closed review queue), `rejected_by_policy`, or `blocked_killswitch` — the model has no override path. Four rails are wired (x402 USDC machine micropayments, Razorpay UPI, Stripe virtual agent cards, Hyperliquid WS quant rail with 5 bps builder rebate), plus per-bot daily limits, operator circuit breakers, and a sandbox faucet. `live_signer` mode signs everything but external network rails stay physically locked in this build.

---

# 📋 OTHER FUNCTIONS (Complete Feature Inventory)

## A. Bots, Profiles, Group Chats & Co-Worker Protocol
- **Bot profiles:** Create, duplicate, and manage local AI bot profiles with custom personas, per-bot flags/permissions, and per-harness account mapping (primary/long-context/fallback accounts).
- **Group chats & squads (chat level):** Multi-bot group conversations with @-mention resolution, selectable coordination modes, and multi-bot round-robin dispatch (Pro-gated squads).
- **Co-worker protocol (`coworker.rs`):** Outcome-first system prompt, action-signature dedup (3rd identical failing call blocked), tiered pivot ladder on failures, definition-of-done contracts compiled from the user prompt, and EXPERIENCE.md lesson persistence.
- **Model routing & failover:** Five provider types — `local_ollama`, `cli_subprocess` (incl. WSL), `byok_api`, `official_oauth` (ChatGPT plan via PKCE), `isolated_webview` — with live health probes and CLI dispatch flags.
- **Routines:** Schedule any thread to run on a timer (daily HH:MM, every 15m/1h, cron).
- **Teach tasks & takeover:** Convert conversations into reusable taught tasks; per-bot human takeover toggle.
- **Attachments:** Thread files through dispatch → answer_bot → run_turn → execute_tool with an **absolute-path allowlist** and **sensitive-path denylist** (workspace_bridge.rs) for security-hardened file access.

## B. Apps, Providers & Tool Detection
- **Environment scan:** Auto-detect installed CLIs, IDEs, and web agents (found/missing/started report).
- **One-click linking:** Link detected tools into the workspace.
- **Provider management:** Add/update/test AI providers; store API keys in the encrypted vault.
- **Sign in with ChatGPT (`siwc.rs`):** Official PKCE OAuth — dynamic client registration, S256 challenge, local 127.0.0.1 callback listener, ID-token iss/aud/nonce validation, refresh-token rotation; the `chatgpt.tokens.use.direct` plan scope lets bots reply from the user's ChatGPT plan without an API key. Cloud refresh tokens stored in the OS keychain (Windows Credential Manager).
- **Model listing & health:** Fetch available models per provider; live health probes.
- **Custom app paths:** Override executable paths; add arbitrary local apps.
- **Fleet actions:** Start/stop/restart detected tool daemons.
- **Harness detection:** Scan all AI harnesses; open dedicated harness windows; run prompts directly against binaries or URLs.

## C. Memory Vault (Mem0-Style, Local)
- **Built-in Mem0-style vault:** SQLite memory with 256-dimensional signed hash-embeddings and cosine similarity ranking, `[[wikilink]]` graph-edge extraction, and an event journal.
- **Multi-engine routing:** Scan memory engines and route memory by scope (global or per-bot); mount/unmount a companion engine; sync memories across engines. **Freemium gate:** Mem0 + Obsidian are free; Zep/Cognee/Letta and other graph/code engines are Pro.
- **Obsidian two-way sync:** Import/refresh/delete with 5,000-note / 20MB caps — not just export.
- **Memory vault actions:** Search and journal via the `memory_vault` command group.

## D. Skills, Plugins, MCP Mesh & Code Mode
- **18 prebuilt skills ship with the app:** computer-use, agent-browser, code-review, find-skills, grill-me, improve-codebase-architecture, vercel-react-best-practices (~90 rule files), remotion-to-hyperframes, hyperframes-cli, composio, mineru (PDF/DOCX/PPTX → Markdown/LaTeX), and 7 NVIDIA skills (accelerated-computing-cudf, cudaq-guide, cuopt ×2, nemo-retriever, nemo-retriever-mcp, nemotron-policy-generator) — each with a governance skill-card.
- **Skill lifecycle:** Save, toggle per-profile, remove, load, and **propose skills from chat** (with approve/reject resolution).
- **Plugin system:** Save, toggle per-agent or per-desktop, trust, and remove plugins (`plugin.yaml` manifests); scan project-local plugins.
- **MCP server management:** Save, toggle, trust, remove MCP servers; connect to MCP servers directly; marketplace installs (Notion, Linear, Sentry, Slack, GitHub, Supabase, filesystem, memory, Playwright, Razorpay MCPs) register the real server.
- **Universal MCP/ACP mesh (`mcp_acp_automesh.rs`):** MCP alias server (port 8765) + ACP JSON-RPC inbox (port 8766) for peer-app tasks; config auto-merging into known clients (ChatGPT/Claude/Gemini/Grok web, Cursor, VS Code, Claude Desktop/Code, Codex, Gemini CLI, Aider, OpenCode, Grokbot, Hermes); per-app share flags; `ask_peer` ticketing.
- **Code Mode (Cloudflare-style, `code_mode.rs`):** Compiles the live MCP/ACP surface into a compact `ronic.d.ts` (with token estimates), then interprets the model's TypeScript block **in-process** — user JS is never evaluated in Node/Bun; a marker denylist blocks `process`, `fetch`, `eval`, imports, and Node builtins.
- **Local MCP bridge (`workspace_bridge.rs`):** Bearer-token HTTP MCP server on **127.0.0.1:47331** exposing memory/skills/plugins/files tools to embedded webviews and CLI harnesses; auto-registers into Claude Code, Cursor, VS Code, Claude Desktop configs; contains the attachment allowlist and sensitive-path denylist.
- **Opt-in cloudflared tunnel (`tunnel.rs`):** Auto-downloaded cloudflared fronts the token-gated MCP alias server with one public URL embedding the bridge token (401 without it); `last_mcp_call` proves a web harness actually connected.
- **Install from URL / git:** Install skills, plugins, and git packages (clone a GitHub repo and register its SKILL.md files).

## E. Marketplace
- **Catalog browsing:** Browse marketplace listings (skills, plugins, tools).
- **MCP-backed installs:** Installing an MCP item registers the real server.
- **Cloud store backend:** Supabase-backed listings, packs, and purchases with review→listed→removed lifecycle; `listing_body()` RPC gates pack bodies to seller-or-paid-buyer.

## F. Computer, Browser & Site Windows
- **3-pillar computer-use subsystem (`computer_subsystem.rs`, ~2,650 LOC):** PiP mini-computer windows, native UIAutomation control-tree driving, and Set-of-Marks vision grounding (see Core Function 2) — plus a process-wide **emergency halt** (`trigger_emergency_computer_halt`) every driver checks.
- **Mini computer shell (`mini_computer.rs`):** Per-bot shell IPC — boot/layout, app/tab switching (Files/Chrome/Terminal), sandboxed per-bot file explorer (list/read/write/mkdir/rename/delete) and history; the calling webview's label identifies the bot so cross-bot access is impossible.
- **URL inspector (`computer.rs`):** SSRF-guarded fetch of http/https URLs (blocks private hosts) extracting up to 40 interactive DOM nodes.
- **Allowlisted sandbox commands:** Run shell commands in a sandbox with an explicit allowlist.
- **Site windows & sign-in choreography (`site_window.rs`):** Edge-impersonating UA + client hints via WebView2 CDP `Emulation.setUserAgentOverride`; Google/Apple OAuth handed off to real Chrome/Edge launched on the site's own EBWebView profile (WebView2 is rejected by those IdPs); popup windows and blank-page recovery.
- **Bot screen windows (`bot_screen.rs`):** Per-bot private browser child-webviews with isolated profiles, workspace-confined shell cwd, and DOM snapshot read-back (up to 40 controls).
- **Page browser & workspace webapps:** Embedded browser with navigation/place/hide controls; positioned workspace webapps; launch desktop apps by id/kind/path (`workspace_apps.rs`).

## G. Coding Agents, IDE & Terminal
- **Coding workspace:** Dedicated IDE screen with a real embedded PTY terminal (xterm.js + `portable-pty`, PowerShell/bash) — per-session readers stream output events; shared between user terminal tabs and bot mini-computer terminals.
- **Git panel (`workspace_git.rs`):** Live status/stage/restore with porcelain parsing, secret-path masking in diffs, and one-click dispatch of tasks to installed CLI agents (claude/aider/codex/gemini/opencode) or opening Cursor/VS Code.
- **IDE agent selection:** Choose the coding agent (which harness drives the IDE).
- **Kernel ops:** DB diagnostics/maintenance, shadow-git pruning, workspace backups (`kernel_ops.rs`).

## H. Bot Fleet, Live Messaging Gateways & Mission Control
- **Fleet dashboard:** Control kernel/bot daemons (status with RAM/PID), routines, and fleet log; start/stop/restart daemon processes; ghost-runner toggle (`bot_fleet.rs`).
- **Bot run control:** Start/stop/pause individual bot runs; per-bot circuit breaker toggle.
- **Live messaging gateways (`gateway_connections.rs`, ~1,600 LOC):** Real integrations with **Telegram** (Bot API long-polling), **Discord** (Gateway WebSocket), **Slack** (Socket Mode), and **WhatsApp** (QR-pairing WebSocket). Credentials validated against live platform APIs; tokens stored server-side only, never sent to the frontend; per-channel atomic counters; Tauri-event status pushes.
- **Strict remote firewall (`messaging_gateway.rs`):** PID-conflict reclaim kills orphaned gateway processes; remote commands honored only when the channel is connected+enabled and the sender matches the allowlisted owner ID; routes `@bot` mentions and `/screen`, `/approve` slash commands.
- **Bi-directional push (`bi_directional_push.rs`):** Interactive push alerts to your phone (wallet approval gates, sentinel incidents) with inline buttons; callbacks honored only from the allowlisted owner.

## I. Workflows (Extended)
- **Visual node-graph editor:** xyflow-based drag-and-drop workflow canvas (WorkflowsStudio).
- **Node kinds:** LLM reasoning, human approval gate, wallet execution, browser automation, bot action, conditional/branch.
- **Execution semantics:** Approval-gate and wallet-execution nodes pause the run as `paused_editable`; Resume approves the gate and continues. One-run-at-a-time mutex, per-step checkpoints, `ronic://wf-progress` Tauri events, steps execute through the real bot engine.
- **Checkpoint previews & resume:** Per-node checkpoint output previews; merge checkpoint snapshot and resume mid-run.
- **YAML mirror:** Every workflow mirrored to `~/.ronicos/workflows/<id>.workflow.yaml`.
- **Bot-authored workflows:** Bots can author workflows via the `save_workflow` agent tool (one step per line: "Title | instruction").
- **Example shipped:** Sales & Marketing Funnel Automation (4-node DAG: lead-capture → lead-qualification → nurture-conversion → retention).

## J. Wallet, Trading & Quant Terminal (Extended)
- **Sandbox ledger:** Full transaction ledger with micro-USD precision ($1.00 = 1,000,000 micro-USD; integer math, no floating-point).
- **Four rails:** x402 USDC machine micropayments, Razorpay UPI (₹400 cap), Stripe virtual agent cards, and Hyperliquid WS quant rail (5 bps builder rebate) — plus a sandbox faucet (3 top-ups/day) and per-bot circuit breakers.
- **Policy gates:** Configurable max_per_tx_usd, daily_cap_usd, require_human_approval_above_usd, max_slippage_bps, killswitch.
- **Two-layer quant pipeline:** LLM signal → Rust policy signer; quant dispatch with pair, side, size, analyst, and thesis; position closing.
- **Ledger modes:** `sandbox` vs `live_signer` — live signs everything but external network rails stay physically locked in this build.
- **Transaction review & top-ups:** Approve/reject pending transactions; add sandbox funds.
- **x402/Burst Compute:** Wallet-gated OpenRouter wholesale proxy (cost + 20%) via the cloud control plane.

## K. Self-Modify, Self-Repair, Sentinels & Kernel Ops
- **4-tier self-repair engine (`remediation_core.rs`, ~860 LOC):** Tier 1 — 500ms anti-hang watchdog + SQLite WAL unlocker; Tier 2 — CDP DOM selector auto-healer with recorded heals; Tier 3 — shadow-git instant checkpoint rollback; Tier 4 — Harness² recursive script/skill auto-patcher with real `node --check` syntax probes and trailing-comma JSON healing.
- **Autonomous sentinel fleet:** 5 sentinels (Sentry, Supabase, Vercel, GitHub, Middleware) running real local checks every 30s in a background thread with capped audit tails; scan individual or all, acknowledge, reset, remediate.
- **Local extensions:** Save, toggle, and **generate** extensions from a natural-language prompt.
- **Repair doctor (`repair.rs`):** Shadow-backup restore (path-name validated), workspace refresh (release stuck turns, WAL checkpoint), and a self-patcher that rewrites known-bad skill scripts with a shadow backup.
- **Kernel ops (`kernel_ops.rs`):** DB diagnostics (page/WAL/freelist bytes), DB maintenance (VACUUM/optimize), shadow-git pruning by age, and whole-workspace folder backups.
- **Harness² engine (`harness2_engine.rs`):** Local coordinator for google-research/harness2 — prompt complexity scoring, recursive plan records, budgeted runs, a run library with keep/promote/revert into the bot's soul.
- **Shadow backups & drills:** List/restore shadow backups; tiered self-heal drills.
- **Bug reports:** Preview and submit — **API keys stripped before saving** (`redact.rs`: Anthropic/OpenAI/Stripe/GitHub keys, bearer tokens, AWS creds, PEM blocks).
- **Reset workspace:** Full workspace reset with confirmation guard.

## L. Settings, Themes & System
- **Settings management:** Save app settings; themes and density applied at runtime.
- **Command palette:** Ctrl/Cmd+K global command palette.
- **Debug overlay:** Ctrl/Cmd+Shift+D debug panel.
- **Recover:** Ctrl/Cmd+Shift+R workspace recovery.
- **Embedded terminal toggle:** Ctrl/Cmd+` terminal.
- **File picker:** Native path picker (files/folders).
- **Save exported files:** Export content to disk via native save dialog.
- **Snapshot polling:** Real-time state snapshot polling.
- **Deep links:** `ronic://` protocol (e.g., auth callback bounce).

## M. Cloud Control Plane (Vercel + Supabase)
- **Dual-gateway billing:** Stripe (USD) + Razorpay (INR/UPI) webhooks, idempotent via `billing_events`.
- **Founder Pass:** Atomic claim, capped at 500, $149 / ₹11,999; badge numbers 1–500; `founder_lifetime` tier with 3 device seats; never downgraded by later Stripe events.
- **Pro subscriptions:** Activate/cancel via webhooks.
- **PKCE desktop auth:** `/auth/bounce` forwards `?code=…` to `ronic://auth/callback`.
- **Burst LLM proxy:** Wallet-gated OpenRouter wholesale (cost + 20% in micro-USD).
- **Ghost runners:** Cloud runner listing; POST returns 501 until the Firecracker cluster ships.
- **Tauri updater:** `/api/releases/latest` serves the update manifest from env.
- **6-table schema:** profiles, device_activations, licenses, founder_pass_pool, compute_wallets, billing_events, ghost_runners — plus marketplace listings/packs/purchases; RLS on all tables; money mutations only via service-role SECURITY DEFINER RPCs.

## N. Security Model (Cross-Cutting)
- **Scoped Tauri capabilities:** Main window IPC only; third-party webviews get **zero** IPC.
- **Loopback-only MCP bridge:** 127.0.0.1 with a fixed tool whitelist.
- **Opt-in public tunnel:** cloudflared only when explicitly enabled.
- **Sensitive-path denylist:** Canonicalized paths checked before absolute-file reads.
- **Attachment allowlist:** Model-controlled file access is explicitly allowlisted.
- **Argon2id + AES-256-GCM vault:** Passphrase-derived key; `lock_vault` wipes the key from memory.
- **Ed25519 offline leases:** 7-day, hardware-bound, tamper-proof.
- **Redacted bug reports:** Secrets stripped before any report is persisted.

---

# 🎯 USER BENEFITS — Why Users Choose Ronic OS

## 1. Total Privacy & Data Sovereignty
Everything runs on your machine. Your conversations, bot configs, memory, API keys, and workflows never leave your disk unless you explicitly opt into a cloud feature. In an era of cloud-everything, Ronic OS is a genuinely local-first workstation.

## 2. One App Replaces Ten
Instead of juggling terminal windows, browser tabs for different AI agents, separate MCP server managers, note-taking apps for memory, and scripting glue for automation — you get a single, coherent shell. Fewer context switches, less setup, more output.

## 3. Run Multiple AI Bots in Parallel, Safely
The multi-bot squad system is genuinely differentiated: isolated cookie partitions and virtual cursors mean bots don't interfere with each other or with your main session, and the blackboard bus lets them collaborate at machine speed. This is multi-agent orchestration done at the OS level, not in a chat thread.

## 4. You Never Lose Control of Spending
The policy engine is a hard, deterministic Rust gate — not a prompt instruction. Set a daily cap, a per-transaction max, a slippage limit, or flip the kill switch, and the AI physically cannot exceed it. For anyone nervous about giving an agent a wallet, this is the answer.

## 5. Enterprise-Grade Security Without the Enterprise
Argon2id key derivation, AES-256-GCM encryption, Ed25519-signed offline licenses, hardware-bound device seats, loopback-only bridges, scoped IPC, redacted bug reports. Security architecture that would cost a team months to build is baked in.

## 6. Workflows That Pause for Your Approval
Automation is only useful if you trust it. Approval gates mean the bot does the work and waits for your sign-off on anything sensitive. Checkpoints mean you can resume from exactly where it paused — no lost state, no re-runs.

## 7. Instant Access to a Curated Skill Library
18 production-grade skills ship in the box — from computer-use and browser agents to NVIDIA GPU tooling, MinerU document parsing, Vercel React best practices, and HyperFrames video. No hunting, no setup; they're installed on launch.

## 8. Works Offline, Licenses Offline
The Ed25519 lease model means paying users get 7 days of full access with zero cloud calls on startup. No "phone home to verify you still exist." The free tier is never artificially crippled locally either — dev mode runs unsigned and every local feature keeps working.

## 9. Self-Healing Workspace
Sentinels watch for problems, shadow backups let you roll back, and the repair doctor fixes the workspace automatically. Bug reports strip your API keys before they're saved. The app maintains itself.

## 10. Built for Power Users
Command palette (Ctrl+K), embedded terminal (Ctrl+`), debug overlay, workspace recovery, deep links, native file pickers, Obsidian export for your memory graph — every interaction is designed for speed.

## 11. Your Bots Live Where You Already Talk
Native Telegram, Discord, Slack, and WhatsApp gateways mean your bots reply inside the apps you already use — with a strict owner-allowlist firewall so only you can issue commands, and interactive push buttons so you can approve a spend or acknowledge an incident from your phone. Tokens are validated against live APIs and never exposed to the frontend.

## 12. Safe Agent Code Execution, Not Just Chat
Code Mode compiles your live MCP/ACP tool surface into a TypeScript definition and interprets the model's code **in-process** with a denylist (no `process`, `fetch`, `eval`, imports, Node builtins) — agents orchestrate tools with real code, but untrusted JS never touches Node/Bun or your shell.

---

# 🏗️ TECHNICAL ARCHITECTURE SUMMARY

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (WebView2), Windows |
| Backend | Rust (~23k lines, 45 modules), tokio async, SQLite (rusqlite, bundled) |
| Frontend | React 19, TypeScript, Vite 7, Tailwind CSS 4, Zustand state |
| UI extras | xterm.js terminal, @xyflow/react node graphs, react-markdown+GFM+highlight |
| Crypto | AES-256-GCM, Argon2id, Ed25519 (dalek), SHA-256, getrandom, OS keychain (keyring) |
| Desktop control | webview2-com, windows-rs (Win32/GDI), uiautomation, portable-pty, image+imageproc (SoM badge stamping) |
| Messaging gateways | Telegram Bot API, Discord Gateway WS, Slack Socket Mode, WhatsApp QR (tokio-tungstenite) |
| Networking | reqwest (rustls), tokio-tungstenite (rustls), cloudflared (opt-in) |
| Cloud control plane | Vercel serverless (zero runtime deps), Supabase (6-table schema + Edge Functions) |
| Billing | Stripe (USD) + Razorpay (INR/UPI), idempotent webhooks |
| Licensing | Ed25519-signed 7-day offline leases, hardware-bound, compile-time public key |
| State | `~/.omniworkspace/state.db` (SQLite, WAL) + `secrets.vault` |
| Protocol | `ronic://` deep links, MCP on 127.0.0.1, CDP for browser driving |

**IPC surface:** 212 Tauri commands (122 in commands.rs + 90 across subsystem modules) grouped into 27 feature domains, registered in `lib.rs` via `tauri::generate_handler!`.

**Bundled content:** 18 prebuilt skills with license notices; 1 example workflow; governance skill-cards for NVIDIA skills.

**Verification:** In-file `#[cfg(test)]` suites validate policy gates, vault round-trips, sentinel break→detect→remediate→verify flows, the attachment allowlist, and Code Mode sandboxing.

---

*Report generated from direct codebase analysis. No source files were modified.*
