import { downloads, primaryDownload } from "./downloads";
import "./download.css";

export function DownloadPage() {
  const primary = primaryDownload(navigator.userAgent);
  const others = downloads.filter((item) => item.id !== primary.id);
  return (
    <div className="app boot">
      <main className="boot-card site-card">
        <img className="boot-logo" src="/brand/logo.png" alt="" />
        <h1 className="boot-title">Ronic OS</h1>
        <p className="boot-sub">A local desktop app for agents, memory, and your tools.</p>
        <a className="btn site-download" href={primary.href}>Download for {primary.label}</a>
        <p className="boot-sub site-note">{primary.note} Version 2.2.0.</p>
        <p className="site-others">
          {others.map((item) => (
            <a key={item.id} href={item.href}>{item.label}</a>
          ))}
        </p>
      </main>
    </div>
  );
}
