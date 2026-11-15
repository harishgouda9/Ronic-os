import { useEffect, useRef, useState, type PointerEvent } from "react";
import { downloads, primaryDownload, type Download } from "./downloads";
import "./download.css";

const SCREENS: { name: string; hook: string; body: string; points: string[] }[] = [
  { name: "Bots & groups", hook: "One chief. The bots do the pieces.", body: "Start in one conversation. A chief can hand a job to a scoped bot with a contract: what done means, which model may spend, and what that bot is not allowed to see.", points: ["The chief stays in the thread you are already in.", "A bot gets the task, not the vault.", "You can see who is working and what it was allowed to touch."] },
  { name: "Messaging Gateway", hook: "Text the desktop from the phone you already use.", body: "Telegram, Slack, Discord, WhatsApp, and the other inboxes you connect land in one gateway. A stranger does not become the owner.", points: ["You approve who can start a turn.", "Clear the allowlist and the next sender is refused.", "Pairing starts on this computer, then the phone can reach it."] },
  { name: "Apps & providers", hook: "Keep the model accounts you already pay for.", body: "Connect the providers and the web apps. Ronic OS does not issue a second bill for the models you already have.", points: ["Keys stay in those accounts.", "ChatGPT, Claude, and the rest can sit beside the chat.", "A site login is not an MCP connection."] },
  { name: "Memory", hook: "The desk remembers. The notes stay here.", body: "Memory is a local database on this computer. Search does not ship the vault out to answer a question.", points: ["A bot can rewrite its own note.", "It cannot replace a note that belongs to another bot.", "You can still edit anything yourself."] },
  { name: "Skills & Capabilities", hook: "Teach it once. Run it again.", body: "Skills, plugins, and MCP tool servers live in one studio, with the permission each one actually has.", points: ["A skill is a playbook the bot can run again.", "Plugins stay scoped.", "You can see the tool servers instead of hunting a config file."] },
  { name: "MCP & ACP mesh", hook: "Connect a tool without handing it the keys.", body: "The mesh is where other apps reach this desktop. A connection is something you make, not something a website login implies.", points: ["MCP and ACP links are listed in one place.", "Each link is a connector, not a blank check.", "You can tell what is connected and what is only open in a browser."] },
  { name: "Harness²", hook: "Small edits stay cheap. Heavy work can step up.", body: "Harness² is the stronger lane for coding work, in the same window as the chat. It does not get its own copy of the vault.", points: ["Short changes can stay on a cheaper or local model.", "Heavier work can move to the harness.", "You stay in the loop on what it spends."] },
  { name: "Bot fleet", hook: "More than one bot. Still one owner.", body: "The fleet is the set of bots you run. Each one stays scoped to its job instead of becoming a second you.", points: ["See the bots without opening another app.", "A chief can hand work across them.", "One bot cannot quietly take another's notes or keys."] },
  { name: "Coding agents", hook: "Give the agent the task, not the machine.", body: "A coding agent, a CLI, or Cursor can receive a short sheet of the open work. Memory and the vault stay on the desktop.", points: ["Context copy packs the goal, the files, and the constraint.", "The agent does not receive the vault.", "You keep the editor and the accounts you already use."] },
  { name: "Computer & browser", hook: "Let it use the computer. Keep your mouse.", body: "Computer use runs in its own windows. You can watch, mark a control, or record one demonstration and turn that into a skill.", points: ["The bot does not take your pointer.", "A marked screen lets a click target one control.", "Show it once, then run that skill again."] },
  { name: "Workflows", hook: "The job you repeat should not need you every time.", body: "A workflow is a saved run. Scheduled jobs live with the chat, and they pause when you close the app unless a cloud runner is connected.", points: ["Turn a finished job into something you can run again.", "A schedule is visible, not a hidden cron you forgot.", "The runner is optional, and it appears only when that cluster is connected."] },
  { name: "Marketplace", hook: "Add a capability. Do not rebuild it.", body: "The marketplace is where extra skills and listings are installed onto this desktop. A listing does not receive the vault.", points: ["Install from the app, not from a random script.", "You choose what turns on.", "What you add stays inside the same permission model."] },
  { name: "Wallet & trading", hook: "Money moves only when you sign.", body: "The wallet can sit in a sandbox, or on a live signed rail. Those are different states, and the header shows which one you are in.", points: ["Practice without a live signature.", "A live rail is a choice, not the default surprise.", "Spend rules live in Settings, on this computer."] },
  { name: "Profile", hook: "The bots work. You are the owner.", body: "Profile is the person this desktop answers to. A bot, a channel, or a connected app does not become that person.", points: ["Your account opens from the Plan screen after install.", "Bots stay scoped under you.", "Sign-in finishes inside the app, not on this website."] },
  { name: "Self-repair", hook: "When the desk breaks, you can see the fix.", body: "Self-repair is a screen, not a silent process. It reports what it can fix, and Settings holds the doctor and failover controls.", points: ["You can read what it is doing.", "You decide what it is allowed to change.", "It does not get a free pass at the vault."] },
  { name: "Plan & setup", hook: "Install free. Pay only for the desk you want.", body: "Starter is the local app. Pro and Founder Pass are billed from the Plan screen after you sign in.", points: ["Pro is $14/mo or ₹999/mo, or $120/yr and ₹9,990/yr.", "Founder Pass is $149 once or ₹11,999 once, capped at 500.", "Cloud runners are $19/mo, and only when that cluster is connected."] },
  { name: "Settings", hook: "Set the desk once. Stop repeating yourself.", body: "Theme, density, the vault, approvals, computer profiles, wallet rules, and updates live here. Auto, ask, or manual is a single choice, not a row of mystery switches.", points: ["Approvals can be automatic, a question, or manual.", "Local data and backups stay on this computer.", "The paths for CLIs, skills, and the computer are visible."] },
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
  const [signInNote, setSignInNote] = useState(false);
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
          <button type="button" className="site-btn ghost" onClick={() => setSignInNote(true)}>Sign in</button>
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
        {signInNote ? <p className="site-signin">Sign-in opens inside the installed app. Download it, then use Account on the Plan screen.</p> : null}

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
            <p className="site-benefit">{openScreen.hook}</p>
            <h3>{openScreen.name}</h3>
            <p>{openScreen.body}</p>
            <ul>
              {openScreen.points.map((point) => <li key={point}>{point}</li>)}
            </ul>
          </article>
        ) : <p className="site-screen-hint">Pick a screen to see what it does for you.</p>}
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
