import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { siteRecovery, siteResetPassword, siteSession, siteSignIn, siteSignOut, siteSignUp, siteUpdatePassword, startSiteAccount, subscribeSiteAccount } from "./account";
import { doorStatus, MCP_URL, toolNames } from "./door";
import { downloads, primaryDownload, type Download } from "./downloads";
import "./download.css";

const SCREENS: { name: string; why: string; features: { name: string; detail: string }[]; benefit: string }[] = [
  { name: "Bots & groups", why: "You need one conversation, then a way to hand a piece of the job to a bot that cannot see everything you can.", features: [{ name: "Chief handoff", detail: "The chief stays in the thread and sends a scoped bot a contract: what done means, which model may spend, and what it cannot see." }, { name: "Task, not the vault", detail: "The bot receives the job. Secrets stay on this computer." }, { name: "Visible work", detail: "You can see who is working and what it was allowed to touch." }], benefit: "One thread runs the desk. Every bot stays scoped under you." },
  { name: "Messaging Gateway", why: "You need to reach this desktop from the phone you already carry, without a stranger starting a turn.", features: [{ name: "The inboxes you use", detail: "Telegram, Slack, Discord, WhatsApp, Signal, WeChat, and BlueBubbles land in one gateway." }, { name: "Allowlist", detail: "You approve who can start a turn. An empty allowlist refuses the next sender." }, { name: "Pairing on this computer", detail: "Pairing starts here. After that, the phone can reach the desk." }], benefit: "Your phone talks to the desktop. It does not become a second owner." },
  { name: "Apps & providers", why: "You need the model accounts you already pay for beside the chat, without a second bill for the same models.", features: [{ name: "Your keys", detail: "Keys stay in the provider accounts you connect." }, { name: "Apps beside the chat", detail: "ChatGPT, Claude, and the other connected web apps sit next to the conversation." }, { name: "Login is not MCP", detail: "Opening an app is a site session. An MCP connection is a separate step." }], benefit: "The desk uses the accounts you already have." },
  { name: "Memory", why: "You need the desk to remember the work, and you need those notes to stay on this computer.", features: [{ name: "Local database", detail: "Memory lives here. Search does not ship the vault out to answer a question." }, { name: "A bot's own note", detail: "A bot can rewrite its own note. It cannot replace a note that belongs to another bot." }, { name: "You can still edit", detail: "You can open any note and change it yourself." }], benefit: "The next session starts from the notes, on this computer." },
  { name: "Skills & Capabilities", why: "You need a job you taught once to run again, with the permission you actually gave it.", features: [{ name: "Playbook skills", detail: "A skill is a playbook the bot can run again." }, { name: "Scoped plugins", detail: "Plugins stay inside the permission you set." }, { name: "MCP tool servers", detail: "Tool servers are listed in this studio with the permission each one has." }], benefit: "Teach it once. You can see what it is allowed to run." },
  { name: "MCP & ACP mesh", why: "You need ChatGPT, Claude, or another agent to call this desktop. A website login does not do that.", features: [{ name: "Public connector", detail: "The address to paste is https://ronicos.vercel.app/mcp. ChatGPT and Claude fetch it from their own servers." }, { name: "Where to paste it", detail: "ChatGPT uses its apps settings. Claude uses custom connectors. Gemini web has no custom MCP connector for consumer accounts." }, { name: "A real check", detail: "Check connection asks this website's door and shows the desktop's tools only when a computer is connected." }], benefit: "You make the connection. The page shows the door's real reply." },
  { name: "Harness²", why: "You need short edits to stay on a cheaper lane and heavier coding to step up, in the same window.", features: [{ name: "Same window", detail: "Harness² is the stronger coding lane beside the chat." }, { name: "Step up the model", detail: "Short changes can stay on a cheaper or local model. Heavier work can move to the harness." }, { name: "No second vault", detail: "It does not get its own copy of the vault." }], benefit: "You stay in the loop on what the heavier lane spends." },
  { name: "Bot fleet", why: "You need more than one bot, and you still need one owner.", features: [{ name: "One list", detail: "See the bots you run without opening another app." }, { name: "Handoff across bots", detail: "A chief can hand work from one scoped bot to another." }, { name: "Separate notes and keys", detail: "One bot cannot take another's notes or keys." }], benefit: "The fleet can grow. The owner stays you." },
  { name: "Coding agents", why: "You need a coding agent, a CLI, or Cursor to receive the task, not the machine.", features: [{ name: "Context copy", detail: "A short sheet packs the goal, the files, and the constraint." }, { name: "Vault stays here", detail: "The agent does not receive the vault." }, { name: "Your editor", detail: "You keep the editor and the accounts you already use." }], benefit: "The agent gets the sheet. The desktop keeps the rest." },
  { name: "Computer & browser", why: "You need the bot to use a screen while your mouse stays yours.", features: [{ name: "Its own windows", detail: "Computer use runs in windows that are not your pointer." }, { name: "Mark a control", detail: "A marked screen lets a click target one control." }, { name: "One demonstration", detail: "Record one demonstration and turn that into a skill you can run again." }], benefit: "You can watch it work. It does not take your pointer." },
  { name: "Workflows", why: "You need a job you already finished to run again without building it a second time.", features: [{ name: "Saved run", detail: "A workflow is that finished job, ready to run again." }, { name: "Visible schedule", detail: "A schedule sits with the chat, where you can see it." }, { name: "Laptop closed", detail: "Scheduled jobs pause when you close the app, unless a cloud runner cluster is connected." }], benefit: "Repeat the job. The runner appears only when that cluster is connected." },
  { name: "Marketplace", why: "You need to add a capability without writing it yourself.", features: [{ name: "Install in the app", detail: "Listings install from the Marketplace screen." }, { name: "You choose what turns on", detail: "Nothing from a listing starts until you enable it." }, { name: "Same permissions", detail: "A listing does not receive the vault." }], benefit: "What you add stays inside the permission model you already use." },
  { name: "Wallet & trading", why: "You need a place to practice, and you need a live payment to wait for your signature.", features: [{ name: "Sandbox", detail: "Practice without a live signature." }, { name: "Live signed rail", detail: "A live rail is a choice. The header shows which state you are in." }, { name: "Spend rules", detail: "Spend rules live in Settings, on this computer." }], benefit: "Money moves when you sign." },
  { name: "Profile", why: "You need the desktop to know the person it answers to.", features: [{ name: "The owner", detail: "Profile is that person. Bots are not the owner." }, { name: "Scoped under you", detail: "A bot, a channel, or a connected app does not become you." }, { name: "The same account", detail: "Sign in here. The installed app uses that account on the Plan screen." }], benefit: "The bots work under you." },
  { name: "Self-repair", why: "You need to see a fix when the desk breaks, instead of a silent process changing things.", features: [{ name: "A visible screen", detail: "Self-repair reports what it can fix." }, { name: "Doctor and failover", detail: "Settings holds those controls." }, { name: "Your decision", detail: "You decide what it may change. It does not get a free pass at the vault." }], benefit: "You can read what it is doing before it changes the desk." },
  { name: "Plan & setup", why: "You need the local app free, and a paid desk only when you choose it inside the app.", features: [{ name: "Starter", detail: "The desktop is free to install, with local memory and the providers you connect." }, { name: "Pro", detail: "$14/mo or ₹999/mo, or $120/yr and ₹9,990/yr, billed from the Plan screen." }, { name: "Founder Pass", detail: "$149 once or ₹11,999 once, capped at 500. Cloud runners are $19/mo and appear only when that cluster is connected." }], benefit: "Install first. Pay from the Plan screen after you sign in." },
  { name: "Settings", why: "You need to set the desk once and stop repeating the same choices.", features: [{ name: "Look and data", detail: "Theme, density, the project, the vault, and memory live here." }, { name: "Approvals", detail: "Auto, ask, or manual is one choice." }, { name: "Paths you can read", detail: "Computer profiles, wallet spend rules, updates, local backups, and the paths for CLIs, skills, and the computer are listed." }], benefit: "The rules sit in one screen, on this computer." },
];

const FEATURES = [
  { id: "chief", name: "01", benefit: "A contract before a bot spends", title: "Chief, then the bots under it", body: "One chief can hand work to scoped bots. Each handoff says what done means, which model may spend, and what the bot is not allowed to see.", proof: "The vault stays with you." },
  { id: "context", name: "02", benefit: "One sheet for the tool you use", title: "Context copy", body: "The open task becomes a short sheet for a web app, a CLI, or Cursor. Your model keys stay in the accounts you already pay for.", proof: "No second set of model keys." },
  { id: "computer", name: "03", benefit: "Your mouse stays yours", title: "Computer use, in its own windows", body: "Watch the screen, mark a control, or record one demonstration and turn that into a skill.", proof: "The bot does not take your pointer." },
  { id: "gateway", name: "04", benefit: "You approve every sender", title: "Message the desktop", body: "Telegram, Slack, Discord, WhatsApp, and the other connected inboxes land in one gateway. An empty allowlist refuses the next sender.", proof: "Pairing starts on this computer." },
  { id: "memory", name: "05", benefit: "Notes stay on this computer", title: "Memory", body: "Notes live in a local database. A bot can rewrite its own note. It cannot replace a note that belongs to another bot.", proof: "Search does not send the vault out." },
  { id: "apps", name: "06", benefit: "A login is not a connection", title: "Apps beside the chat", body: "ChatGPT, Claude, and the other web apps open from the desktop, next to the conversation.", proof: "MCP is a separate connection." },
];

const PINS = [
  { id: "header", n: "1", x: "30%", y: "4%", title: "Header", body: "Jump to a screen, the license state, and refresh sit in the top bar." },
  { id: "rail", n: "2", x: "3.2%", y: "42%", title: "Rail", body: "The screen list stays on the left edge of the window." },
  { id: "chief", n: "3", x: "36%", y: "46%", title: "Chief", body: "The conversation and the handoff sit in the middle." },
  { id: "apps", n: "4", x: "88%", y: "36%", title: "Apps", body: "Connected web apps sit on the right. A site login is not an MCP connection.", edge: true },
];

const SHOT = "Ronic OS desktop, with the bot list, a chief conversation, the computer panel, and connected web apps";

function DoorCheck() {
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const [tools, setTools] = useState<string[]>([]);

  async function copy() {
    field.current?.focus();
    field.current?.select();
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function check() {
    setBusy(true);
    setTools([]);
    setStatus("Checking the door…");
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    try {
      const opened = await fetch("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ronic-site", version: "2.2.0" } },
        }),
      });
      const text = await opened.text();
      const door = doorStatus(opened.status, text);
      setStatus(door.ok ? `Connected. ${door.detail}` : door.detail);
      const session = opened.headers.get("mcp-session-id");
      if (!door.ok || !session) return;
      try {
        await fetch("/mcp", {
          method: "POST",
          headers: { ...headers, "mcp-session-id": session },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
        const listed = await fetch("/mcp", {
          method: "POST",
          headers: { ...headers, "mcp-session-id": session },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        });
        setTools(toolNames(await listed.text()));
      } catch {
        // Initialize already reported the door. A later tools call must not hide that.
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "The door did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="site-door">
      <label>
        Connector URL
        <input ref={field} readOnly value={MCP_URL} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <div className="site-door-actions">
        <button type="button" className="site-btn ghost" onClick={copy}>{copied ? "Copied" : "Copy URL"}</button>
        <button type="button" className="site-btn" onClick={check} disabled={busy} aria-busy={busy}>{busy ? "Checking…" : "Check connection"}</button>
      </div>
      <p>Paste this into ChatGPT or Claude. Check connection calls this website and shows the reply it gets.</p>
      {status ? <p role="status">{status}</p> : null}
      {tools.length ? <p>Tools: {tools.join(", ")}</p> : null}
    </div>
  );
}

function SiteAccount() {
  const session = useSyncExternalStore(subscribeSiteAccount, siteSession, () => null);
  const recovery = useSyncExternalStore(subscribeSiteAccount, siteRecovery, () => false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = email.trim().includes("@") && password.length >= 8;

  useEffect(() => { startSiteAccount(); }, []);

  function finish(message: string) {
    setNote(message);
    setBusy(false);
  }

  return (
    <>
      <button type="button" className="site-btn ghost" onClick={() => dialog.current?.showModal()}>
        <span className="site-account">{session?.user.email ?? "Sign in"}</span>
      </button>
      <dialog
        ref={dialog}
        className="site-auth"
        aria-label="Account"
        onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
      >
        <button type="button" className="site-btn ghost" onClick={() => dialog.current?.close()}>Close</button>
        {session ? (
          <div>
            <h3>Signed in</h3>
            <p>{session.user.email}</p>
            {recovery ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setBusy(true);
                  void siteUpdatePassword(nextPassword).then((message) => finish(message || "Password saved."));
                }}
              >
                <label>New password<input type="password" autoComplete="new-password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} /></label>
                <div className="site-auth-actions">
                  <button className="site-btn" disabled={busy || nextPassword.length < 8}>Save password</button>
                </div>
              </form>
            ) : null}
            <div className="site-auth-actions">
              <button type="button" className="site-btn ghost" disabled={busy} onClick={() => { setBusy(true); void siteSignOut().then(() => finish("Signed out.")); }}>Sign out</button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void siteSignIn(email, password).then((message) => finish(message || "Signed in.")).catch((error) => finish(error instanceof Error ? error.message : "Sign-in failed."));
            }}
          >
            <h3>Sign in</h3>
            <p>This is the Ronic account. It is not an MCP connection.</p>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <div className="site-auth-actions">
              <button className="site-btn" disabled={busy || !ready}>Sign in</button>
              <button
                type="button"
                className="site-btn ghost"
                disabled={busy || !ready}
                onClick={() => {
                  setBusy(true);
                  void siteSignUp(email, password, window.location.origin).then((message) => finish(message || "Account created. You are signed in.")).catch((error) => finish(error instanceof Error ? error.message : "The account could not be created."));
                }}
              >Create account</button>
            </div>
            <button
              type="button"
              className="site-text"
              disabled={busy || !email.trim().includes("@")}
              onClick={() => {
                setBusy(true);
                void siteResetPassword(email, window.location.origin).then((message) => finish(message || "Reset email sent. Open the link in this browser."));
              }}
            >Forgot password</button>
          </form>
        )}
        {note ? <p role="status">{note}</p> : null}
      </dialog>
    </>
  );
}

function tilt(event: PointerEvent<HTMLDivElement>) {
  if (event.pointerType === "touch") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width - 0.5;
  const y = (event.clientY - box.top) / box.height - 0.5;
  event.currentTarget.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
  event.currentTarget.style.setProperty("--rx", `${(-y * 5).toFixed(2)}deg`);
}

export function DownloadPage() {
  const [file, setFile] = useState<Download>(() => primaryDownload(navigator.userAgent));
  const [inr, setInr] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [screen, setScreen] = useState<string | null>(null);
  const openScreen = SCREENS.find((item) => item.name === screen);
  const light = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const id = "site-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }, []);

  return (
    <div className="site">
      <header className="site-bar">
        <a className="site-brand" href="#top">
          <img src="/brand/logo.png" alt="Ronic OS" />
        </a>
        <nav className="site-nav" aria-label="Page">
          <a href="#desk">The desk</a>
          <a href="#screens">Screens</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="site-bar-actions">
          <SiteAccount />
          <a className="site-btn" href={file.href}>Download</a>
        </div>
      </header>

      <section className="site-hero" id="top">
        <p className="site-kicker">Desktop app · version 2.2.0</p>
        <h1>One <span>local workstation</span> for the bots and apps you already use.</h1>
        <p className="site-lead">
          Ronic OS installs on your computer. Chat, memory, computer use, and the messaging gateway run there. Model accounts stay in the providers you connect.
        </p>
        <div className="site-os" role="group" aria-label="Choose an installer">
          {downloads.map((item) => (
            <button key={item.id} type="button" aria-pressed={item.id === file.id} onClick={() => setFile(item)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="site-cta" id="download">
          <a className="site-btn" href={file.href}>Download for {file.label}</a>
          <a className="site-btn ghost" href="#pricing">See plans</a>
        </div>
        <p className="site-fine">{file.note}</p>

        <div className="site-beam" onPointerMove={tilt} onPointerLeave={(event) => { event.currentTarget.style.removeProperty("--rx"); event.currentTarget.style.removeProperty("--ry"); }}>
          <figure className="site-frame">
            <div className="site-frame-scroll">
              <div className="site-shot">
                <img src="/site/app.png" alt={SHOT} width={1917} height={1015} />
                {PINS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={"edge" in item && item.edge ? "site-pin edge" : "site-pin"}
                    style={{ left: item.x, top: item.y }}
                    aria-expanded={pin === item.id}
                    onClick={() => setPin((current) => current === item.id ? null : item.id)}
                  >
                    {item.n}
                    <span><strong>{item.title}</strong> {item.body}</span>
                  </button>
                ))}
              </div>
            </div>
            <figcaption>
              <span>The desktop, on this computer. <span className="site-pan">Swipe sideways to see the whole window.</span></span>
              <button type="button" className="site-inspect" onClick={() => light.current?.showModal()}>Inspect</button>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="site-facts" aria-label="What the desktop keeps">
        <div>
          <strong>Local vault</strong>
          <p>Secrets stay on this computer. A license lease, when you use one, is checked here too.</p>
        </div>
        <div>
          <strong>Your providers</strong>
          <p>Model keys stay in the apps and accounts you connect. The desktop does not replace them.</p>
        </div>
        <div>
          <strong>One installer</strong>
          <p>Windows, Mac, and Linux. The setup adds a Start Menu entry and a desktop shortcut.</p>
        </div>
      </section>

      <section className="site-block" id="desk">
        <p className="site-kicker">Why it is local</p>
        <h2>The desk is the product.</h2>
        <p className="site-lead">Each part of the window has a limit. The bot gets the task. It does not get the vault.</p>
        <div className="site-grid">
          {FEATURES.map((item) => (
            <article key={item.id} className="site-card site-reveal" id={item.id === "memory" ? "memory" : undefined}>
              <p className="site-benefit">{item.benefit}</p>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <p className="site-proof">{item.proof}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="site-block" id="screens">
        <p className="site-kicker">The rail</p>
        <h2>Seventeen screens. One window.</h2>
        <div className="site-chips" role="group" aria-label="Screens">
          {SCREENS.map((item) => (
            <button key={item.name} type="button" aria-pressed={screen === item.name} onClick={() => setScreen((current) => current === item.name ? null : item.name)}>
              {item.name}
            </button>
          ))}
        </div>
        {openScreen ? (
          <article className="site-screen" key={openScreen.name} aria-live="polite">
            <p className="site-benefit">Why you need it</p>
            <h3>{openScreen.name}</h3>
            <p>{openScreen.why}</p>
            <p className="site-label">Features</p>
            <ul>
              {openScreen.features.map((feature) => <li key={feature.name}><strong>{feature.name}.</strong> {feature.detail}</li>)}
            </ul>
            <p className="site-label">Benefit</p>
            <p>{openScreen.benefit}</p>
            {openScreen.name === "MCP & ACP mesh" ? <DoorCheck /> : null}
          </article>
        ) : <p className="site-screen-hint">Pick a screen to see why you need it.</p>}
      </section>

      <section className="site-band" id="pricing">
        <div className="site-band-inner">
          <p className="site-kicker">Plans</p>
          <h2>Install free. Pay inside the app.</h2>
          <p className="site-lead">The local app is free to install. Paid plans are billed from the Plan screen after you sign in.</p>
          <div className="site-switch" data-inr={inr} role="group" aria-label="Currency">
            <span className="site-switch-thumb" aria-hidden="true" />
            <button type="button" aria-pressed={!inr} onClick={() => setInr(false)}>USD</button>
            <button type="button" aria-pressed={inr} onClick={() => setInr(true)}>INR</button>
          </div>
          <div className="site-plans">
            <article className="site-card">
              <h3>Starter</h3>
              <p className="site-price" key={inr ? "s-inr" : "s-usd"}>{inr ? "₹0" : "$0"}</p>
              <p>The desktop, local memory, bots on this computer, and the providers you connect yourself.</p>
              <a className="site-btn" href={file.href}>Download free</a>
            </article>
            <article className="site-card">
              <h3>Pro</h3>
              <p className="site-price" key={inr ? "p-inr" : "p-usd"}>{inr ? "₹999/mo" : "$14/mo"}</p>
              <p>{inr ? "₹9,990/yr with UPI." : "$120/yr with a card."} Paid from the Plan screen in the app.</p>
              <a className="site-btn ghost" href={file.href}>Install to subscribe</a>
            </article>
            <article className="site-card featured">
              <h3>Founder Pass</h3>
              <p className="site-price" key={inr ? "f-inr" : "f-usd"}>{inr ? "₹11,999 once" : "$149 once"}</p>
              <p>Lifetime Pro on the desktop. Capped at 500 passes. Claim it from the Plan screen after you sign in.</p>
              <a className="site-btn" href={file.href}>Install to claim</a>
            </article>
            <article className="site-card">
              <h3>Cloud runners</h3>
              <p className="site-price">$19/mo</p>
              <p>A runner that keeps a scheduled job up while the laptop is closed. It appears in the app when that cluster is connected.</p>
            </article>
          </div>
        </div>
      </section>

      <footer className="site-foot">
        <div className="site-foot-inner">
          <div>
            <img src="/brand/logo.png" alt="" />
            <p>Ronic OS 2.2.0. Windows may ask you to confirm an unsigned setup file.</p>
          </div>
          <a className="site-btn" href={file.href}>Download for {file.label}</a>
        </div>
      </footer>

      <dialog
        ref={light}
        className="site-light"
        aria-label="Desktop screenshot"
        onClick={(event) => { if (event.target === event.currentTarget) light.current?.close(); }}
      >
        <form method="dialog"><button className="site-btn ghost">Close</button></form>
        <img src="/site/app.png" alt={SHOT} />
      </dialog>
    </div>
  );
}
