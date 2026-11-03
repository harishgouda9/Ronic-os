# Ronic OS 

A local-first agent workstation for Windows, macOS, and Linux. One desktop shell where coding
CLIs, web agents, MCP servers, bot profiles, memory, skills, workflows, and a
sandbox wallet share a single workspace — with no server-side dependency for
the core loop.

## Screenshots

These are the running desktop app.

The chat, with each web app's own icon.

![Chat with app icons](docs/screenshots/chat-icons.png)

A site window opened from the bot computer.

![Site window](docs/screenshots/site-window.png)

<details>
<summary><mark>View screenshots</mark></summary>

Apps and providers already found on this computer.

![Apps and providers](docs/screenshots/apps-providers.png)

Skills, plugins, and MCP servers.

![Skills and capabilities](docs/screenshots/skills.png)

A workflow on the canvas.

![Workflow](docs/screenshots/workflow.png)

Connect apps, OAuth providers, and MCP tools.

![Connect catalog](docs/screenshots/connect.png)

Wallet and quant terminal. Balances stay on this computer.

![Wallet](docs/screenshots/wallet.png)

Messaging gateway.

![Messaging gateway](docs/screenshots/messaging.png)

</details>

- **Frontend:** React 19 + TypeScript + Vite 7 + Tailwind 4 + Zustand
- **Desktop shell:** Tauri 2 (WebView2 on Windows, WebKit on macOS/Linux), Rust backend (~23k lines)
- **State:** SQLite (`state.db` under `~/.ronicos`) + encrypted vault
  (Argon2id passphrases, AES-256-GCM secrets)

## What is in the box

| Screen | What it does |
| --- | --- |
| Bots & groups | Chat with local bot profiles, group chats, model routing, failover |
| Apps & providers | Detect and link CLIs, IDEs, web agents; store API keys in the vault |
| Memory | Local Mem0-style vault, graph edges, Obsidian export |
| Skills & Capabilities | SKILL.md playbooks, MCP servers, plugins, project plugins |
| MCP & ACP mesh | Local MCP bridge (127.0.0.1), harness registration, cloudflared tunnel |
| Bot fleet | Daemon control, routines, fleet log |
| Coding agents | Coding workspace with embedded terminal, git status |
| Computer & browser | URL inspector and allowlisted sandbox commands |
| Workflows | Multi-step bot runs with approval gates and checkpoints |
| Marketplace | Catalog installs (MCP-backed items register the real server) |
| Wallet & trading | Sandbox ledger with policy gates (live rails are off in this build) |
| Self-modify / Self-repair | Local extensions and a doctor that repairs the workspace |

## Commands

```bash
npm install            # once
npm run desktop        # dev: vite + tauri window (handles stale ports/orphans)
npm run desktop:build  # native release bundles for the current OS
npm run desktop:build:binary # release binary only, without an installer bundle
npm run typecheck      # tsc --noEmit
npm test               # desktop.mjs unit tests (node:test)
npm run test:rust      # Rust unit tests (embeds the comctl6 manifest on Windows)
```

## Build notes

- Windows GNU builds use a target directory under `%LOCALAPPDATA%\ronicos-target`
  because `windres` cannot preprocess paths that contain spaces. macOS and
  Linux builds use the native user cache directory. **Run builds through
  `npm run desktop…`, not bare `cargo build`, so this path handling is applied.**
- `npm run test:rust` needs `mt.exe` from the Windows SDK to embed the
  Common-Controls v6 manifest into the test binary.
- The Rust lib is built `rlib`-only: the MinGW linker rejects a cdylib once
  Rust's export ordinals pass 65535.

The release command produces a real native installer/package rather than a
browser wrapper:

| Host | Release artifacts |
| --- | --- |
| Windows x64 | NSIS `*-setup.exe` and MSI |
| macOS Intel / Apple Silicon | DMG and `.app` |
| Linux x64 | AppImage, `.deb`, and `.rpm` |

The GitHub Actions workflow in `.github/workflows/release.yml` builds these
artifacts on native runners when a `v*` tag is pushed and publishes them to a
GitHub Release. Windows NSIS installs for the current user and creates a Start
Menu entry plus a desktop shortcut. The Windows bundle includes the WebView2
offline installer so first installation does not depend on a separate runtime
download.

The packaged app embeds the Rust backend and its SQLite/local services. Release
users do not need Node.js, Vite, or a localhost development server. The backend
binds its optional bridge and model endpoint to `127.0.0.1`, so normal installs
do not require an inbound Windows Firewall rule.

## Publishing a release

1. Update the version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`.
2. Commit and push a matching tag, for example `v2.2.0`.
3. Download the installers from the generated GitHub Release. Users can click
   the Windows `*-setup.exe`, open the macOS `.dmg`, or install the Linux
   package/AppImage.

Windows and macOS code-signing secrets are optional in the workflow. Configure
them before publishing if you want the OS download warning and SmartScreen
reputation to identify your publisher. The workflow reads `WINDOWS_CERTIFICATE`
and `WINDOWS_CERTIFICATE_PASSWORD` for a base64 PFX, plus `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`,
`APPLE_PASSWORD`, and `APPLE_TEAM_ID` for Apple signing/notarization. Unsigned
or ad-hoc-signed artifacts still build and run when those secrets are absent.

## Security model (short version)

- Secrets live in `~/.ronicos/secrets.vault` (AES-256-GCM; key derived
  with Argon2id from your passphrase). `lock_vault` drops the key from memory.
- The main window's Tauri capabilities are scoped to `windows: ["main"]` —
  webviews that host third-party sites get no IPC.
- The MCP bridge listens on 127.0.0.1 only and answers a fixed tool whitelist;
  the public tunnel (cloudflared) is opt-in.
- Bug reports strip API keys before they are saved anywhere.

## Repo layout

```
src/            React app (screens, components, kernel glue, browser preview)
src-tauri/      Rust backend (commands, agent loop, bridge, fleet, vault, licensing)
backend/        Vercel control plane (billing webhooks, burst proxy, PKCE bounce)
supabase/       schema.sql + license-lease Edge Function (Ed25519 signer)
scripts/        desktop dev/build orchestration + test runners
```

## Cloud licensing (summary)

The desktop verifies Ed25519-signed 7-day leases offline — see
[`backend/README.md`](backend/README.md) for the deploy/secrets checklist and
`supabase/schema.sql` for the tables. Release builds compile in
`RONIC_ED25519_PUBLIC_KEY`; without it the app runs in unsigned dev mode
(license shown, never enforced) and every local feature keeps working.
