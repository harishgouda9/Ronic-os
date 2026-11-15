import { useEffect, useState } from "react";
import { downloads, primaryDownload, type Download } from "./downloads";
import "./download.css";

const SCREENS = [
  "Bots & groups",
  "Messaging Gateway",
  "Apps & providers",
  "Memory",
  "Skills & Capabilities",
  "MCP & ACP mesh",
  "Harness²",
  "Bot fleet",
  "Coding agents",
  "Computer & browser",
  "Workflows",
  "Marketplace",
  "Wallet & trading",
  "Profile",
  "Self-repair",
  "Plan & setup",
  "Settings",
];

const FEATURES: { id: string; name: string; title: string; body: string }[] = [
  {
    id: "chief",
    name: "01",
    title: "A chief, then the bots under it",
    body: "One chief can hand work to scoped bots. Each handoff says what done means, which model may spend, and what the bot is not allowed to see.",
  },
  {
    id: "context",
    name: "02",
    title: "One copy of the work",
    body: "Context copy packs the open task into a short sheet and can hand it to a web app, a CLI, or Cursor. Your model keys stay where you already pay for them.",
  },
  {
    id: "computer",
    name: "03",
    title: "The computer, in its own windows",
    body: "You can watch the screen, mark a control, or record one demonstration and turn that into a skill. The bot does not take your mouse.",
  },
  {
    id: "gateway",
    name: "04",
    title: "Messages from the apps you have",
    body: "Telegram, Slack, and the other connected inboxes land in one gateway. You approve who can start a turn. An empty allowlist refuses the next sender.",
  },
  {
    id: "memory",
    name: "05",
    title: "Memory on this computer",
    body: "Notes live in a local database. A bot can rewrite its own note. It cannot replace a note that belongs to another bot.",
  },
  {
    id: "apps",
    name: "06",
    title: "The apps, beside the chat",
    body: "ChatGPT, Claude, and the other web apps open from the desktop. A site login is not an MCP connection. The vault stays local.",
  },
];

export function DownloadPage() {
  const [file, setFile] = useState<Download>(() => primaryDownload(navigator.userAgent));
  const [inr, setInr] = useState(false);
  const [signInNote, setSignInNote] = useState(false);

  useEffect(() => {
    const id = "site-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
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
        <h1>One local workstation for the bots and apps you already use.</h1>
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

        <figure className="site-frame">
          <div className="site-frame-scroll">
            <img
              src="/site/app.png"
              alt="Ronic OS desktop, with the bot list, a chief conversation, the computer panel, and connected web apps"
              width={1917}
              height={1015}
            />
          </div>
          <figcaption>
            <span>The desktop, on this computer.</span>
            <span className="site-pan">Swipe sideways to see the whole window.</span>
          </figcaption>
        </figure>
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
        <p className="site-kicker">Inside the window</p>
        <h2>The desk is the product.</h2>
        <p className="site-lead">Bots on the left, the conversation in the middle, the computer and your apps on the right.</p>
        <div className="site-grid">
          {FEATURES.map((item) => (
            <article key={item.id} className="site-card" id={item.id === "memory" ? "memory" : undefined}>
              <p className="site-index">{item.name}</p>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="site-block" id="screens">
        <p className="site-kicker">The rail</p>
        <h2>Seventeen screens. One window.</h2>
        <ul className="site-chips">
          {SCREENS.map((name) => <li key={name}>{name}</li>)}
        </ul>
      </section>

      <section className="site-band" id="pricing">
        <div className="site-band-inner">
          <p className="site-kicker">Plans</p>
          <h2>Install free. Pay inside the app.</h2>
          <p className="site-lead">The local app is free to install. Paid plans are billed from the Plan screen after you sign in.</p>
          <div className="site-currency" role="group" aria-label="Currency">
            <button type="button" aria-pressed={!inr} onClick={() => setInr(false)}>USD</button>
            <button type="button" aria-pressed={inr} onClick={() => setInr(true)}>INR</button>
          </div>
          <div className="site-plans">
            <article className="site-card">
              <h3>Starter</h3>
              <p className="site-price">{inr ? "₹0" : "$0"}</p>
              <p>The desktop, local memory, bots on this computer, and the providers you connect yourself.</p>
              <a className="site-btn" href={file.href}>Download free</a>
            </article>
            <article className="site-card">
              <h3>Pro</h3>
              <p className="site-price">{inr ? "₹999/mo" : "$14/mo"}</p>
              <p>{inr ? "₹9,990/yr with UPI." : "$120/yr with a card."} Paid from the Plan screen in the app.</p>
              <a className="site-btn ghost" href={file.href}>Install to subscribe</a>
            </article>
            <article className="site-card featured">
              <h3>Founder Pass</h3>
              <p className="site-price">{inr ? "₹11,999 once" : "$149 once"}</p>
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
    </div>
  );
}
