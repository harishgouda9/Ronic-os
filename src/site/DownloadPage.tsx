import { useState } from "react";
import { downloads, primaryDownload, type Download } from "./downloads";
import "./download.css";

const RAIL = [
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

type Tab = "chief" | "context" | "computer" | "gateway" | "memory";

const TABS: { id: Tab; label: string; rail: string }[] = [
  { id: "chief", label: "Chief", rail: "Bots & groups" },
  { id: "context", label: "Context copy", rail: "Skills & Capabilities" },
  { id: "computer", label: "Computer", rail: "Computer & browser" },
  { id: "gateway", label: "Gateway", rail: "Messaging Gateway" },
  { id: "memory", label: "Memory", rail: "Memory" },
];

const COPY: Record<Tab, { title: string; body: string; rows: [string, string][] }> = {
  chief: {
    title: "Chief and the bots under it",
    body: "One chief can hand work to scoped bots. Each handoff is a small contract: what done means, which model is allowed to spend, and what the bot is not allowed to see.",
    rows: [
      ["Contract first", "A job splits into checks the bot can pass or fail, such as a test or a page assertion."],
      ["Cost", "Short edits stay on a cheap or local model. Heavier work can move to a stronger harness."],
      ["Secrets", "A bot does not receive the vault. It gets the task, not the keys."],
      ["Pushback", "A bot can stop and ask when the instruction is ambiguous."],
    ],
  },
  context: {
    title: "One copy of the work, sent to the tool you already use",
    body: "Context copy packs the open task into a short sheet and can hand it to a web app, a CLI, or Cursor. Your model keys stay in the apps you already pay for.",
    rows: [
      ["The sheet", "The current goal, the files that matter, and the constraint."],
      ["Where it goes", "A connected app, a terminal agent, or an editor rule."],
      ["What stays here", "The desktop keeps memory and the vault on this computer."],
    ],
  },
  computer: {
    title: "The computer, without giving the bot your mouse",
    body: "Computer use runs in its own windows. You can watch the screen, mark a control, or record one demonstration and turn that into a repeatable skill.",
    rows: [
      ["Separate windows", "Each bot can have its own desktop view."],
      ["A marked screen", "Controls can be numbered so a click targets one control."],
      ["Show it once", "A recording becomes a skill the bot can run again."],
    ],
  },
  gateway: {
    title: "Message the desktop from the apps you already have",
    body: "Telegram, Slack, and the other connected inboxes land in one gateway. A stranger does not become the owner. You approve who can start a turn.",
    rows: [
      ["One inbox", "Channels share the same owner list and the same bot turn."],
      ["An empty list", "If you clear the allowlist, the next sender is refused."],
      ["Pairing", "A channel connects from the desktop, then the phone can reach it."],
    ],
  },
  memory: {
    title: "Memory that stays on this computer",
    body: "Notes live in a local database. A bot can rewrite its own note. It cannot replace a note that belongs to another bot. You can still edit anything yourself.",
    rows: [
      ["Your notes", "A title, a body, and links to related notes."],
      ["A bot's notes", "Scoped to that bot, so another bot cannot overwrite them."],
      ["Search", "The desktop searches the local store. It does not send the vault out to do that."],
    ],
  },
};

export function DownloadPage() {
  const [file, setFile] = useState<Download>(() => primaryDownload(navigator.userAgent));
  const [tab, setTab] = useState<Tab>("chief");
  const [terminal, setTerminal] = useState(false);
  const [inr, setInr] = useState(false);
  const [signInNote, setSignInNote] = useState(false);
  const panel = COPY[tab];
  const railCurrent = TABS.find((item) => item.id === tab)?.rail;

  return (
    <div className="site">
      <header className="site-bar">
        <a className="site-brand" href="#top">
          <img src="/brand/logo.png" alt="Ronic OS" />
          <span className="site-pill">v2.2.0 · local</span>
        </a>
        <nav className="site-nav" aria-label="Page">
          <a href="#workstation">Workstation</a>
          <a href="#chief">Chief</a>
          <a href="#computer">Computer</a>
          <a href="#memory">Memory</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="site-bar-actions">
          <button type="button" className="site-btn ghost" onClick={() => setSignInNote(true)}>Sign in</button>
          <a className="site-btn" href={file.href}>Download</a>
        </div>
      </header>

      <section className="site-hero" id="top">
        <p className="site-kicker">Desktop app · Windows, Mac, and Linux</p>
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
        <p className="site-fine">{file.note} Version 2.2.0.</p>
        {signInNote ? <p className="site-signin">Sign-in opens inside the installed app. Download it, then use Account on the Plan screen.</p> : null}

        <div className="site-shell" id="workstation">
          <div className="site-chrome">
            <span className="site-dots" aria-hidden="true"><i /><i /><i /></span>
            <strong>Ronic OS</strong>
            <span className="site-jump">Jump to a screen · Ctrl K</span>
          </div>
          <div className="site-shell-body">
            <nav className="site-rail" aria-label="Screens in the app">
              {RAIL.map((label) => (
                <button
                  key={label}
                  type="button"
                  aria-current={label === railCurrent}
                  onClick={() => {
                    const next = TABS.find((item) => item.rail === label);
                    if (next) setTab(next.id);
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="site-stage">
              <div className="site-tabs" role="tablist">
                {TABS.map((item) => (
                  <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="site-panel" role="tabpanel">
                <h2>{panel.title}</h2>
                <p>{panel.body}</p>
                <ul className="site-list">
                  {panel.rows.map(([name, text]) => (
                    <li key={name}><strong>{name}</strong> — {text}</li>
                  ))}
                </ul>
              </div>
              <button type="button" className="site-term-toggle" aria-expanded={terminal} onClick={() => setTerminal((open) => !open)}>
                {terminal ? "Hide terminal" : "Show terminal"}
              </button>
              {terminal ? (
                <pre className="site-term">{`PS> cargo check\n    Finished dev profile\nPS> bun test\n  local tests passed`}</pre>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="site-block" id="chief">
        <h2>How a chief hands work down</h2>
        <p className="site-lead">The same four rules the desktop uses when one bot asks another to do a piece of the job.</p>
        <div className="site-grid">
          {COPY.chief.rows.map(([name, text]) => (
            <article key={name} className="site-card">
              <h3>{name}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="site-block" id="computer">
        <h2>Computer use and memory</h2>
        <div className="site-grid">
          <article className="site-card">
            <h3>Computer & browser</h3>
            <p>{COPY.computer.body}</p>
          </article>
          <article className="site-card" id="memory">
            <h3>Memory</h3>
            <p>{COPY.memory.body}</p>
          </article>
        </div>
      </section>

      <section className="site-block" id="pricing">
        <h2>Plans</h2>
        <p className="site-lead">The local app is free to install. Paid plans are billed inside the app after you sign in.</p>
        <div className="site-currency" role="group" aria-label="Currency">
          <button type="button" aria-pressed={!inr} onClick={() => setInr(false)}>USD</button>
          <button type="button" aria-pressed={inr} onClick={() => setInr(true)}>INR</button>
        </div>
        <div className="site-grid">
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
      </section>

      <footer className="site-foot">
        <div className="site-foot-inner">
          <h2>On this computer</h2>
          <p>
            Secrets stay in a local vault. A license lease, when you use one, is checked on the desktop. The installer adds a Start Menu entry and a desktop shortcut. Windows may ask you to confirm an unsigned setup file.
          </p>
          <p>Ronic OS 2.2.0 · <a href={file.href}>Download for {file.label}</a></p>
        </div>
      </footer>
    </div>
  );
}
