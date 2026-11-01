import { Clock, HardDrive } from "lucide-react";
import type { ShellState } from "../types";
import type { ShellBoot } from "../types";

export function ChromeLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="20" fill="#EA4335" />
      <path d="M24 14H39.5C36.2 8.7 30.5 5 24 5C17.5 5 11.8 8.7 8.5 14L16.2 27.5L24 14Z" fill="#EA4335" />
      <path d="M39.5 14H24L16.2 27.5L12.5 34C15.8 39.3 21.5 43 28 43C34.5 43 40.2 39.3 43.5 34L39.5 14Z" fill="#34A853" />
      <path d="M4.5 24C4.5 30.5 8.2 36.2 13.5 39.5L21.2 26L17.5 19.5L8.5 14C6 16.9 4.5 20.3 4.5 24Z" fill="#FBBC05" />
      <circle cx="24" cy="24" r="9" fill="#FFFFFF" />
      <circle cx="24" cy="24" r="7" fill="#4285F4" />
    </svg>
  );
}

export function FilesLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="files-back" x1="0" y1="0" x2="0" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
        <linearGradient id="files-front" x1="0" y1="0" x2="0" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      <rect x="5" y="10" width="16" height="10" rx="3" fill="#1E40AF" />
      <rect x="5" y="14" width="38" height="26" rx="4" fill="url(#files-back)" />
      <path d="M5 22C5 19.7909 6.79086 18 9 18H39C41.2091 18 43 19.7909 43 22V36C43 38.2091 41.2091 40 39 40H9C6.79086 40 5 38.2091 5 36V22Z" fill="url(#files-front)" />
      <rect x="11" y="24" width="14" height="2" rx="1" fill="rgba(255,255,255,0.7)" />
      <rect x="11" y="29" width="22" height="2" rx="1" fill="rgba(255,255,255,0.4)" />
    </svg>
  );
}

export function TerminalLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4" y="8" width="40" height="32" rx="6" fill="#181825" stroke="#313244" strokeWidth="1.5" />
      <circle cx="10" cy="14" r="2" fill="#F38BA8" />
      <circle cx="16" cy="14" r="2" fill="#F9E2AF" />
      <circle cx="22" cy="14" r="2" fill="#A6E3A1" />
      <path d="M12 24L18 29L12 34" stroke="#89B4FA" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="22" y1="34" x2="32" y2="34" stroke="#A6E3A1" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function DesktopView({ boot, onOpen }: { boot: ShellBoot; onOpen: (app: ShellState["app"]) => void }) {
  const botHandle = boot?.botHandle || "Bot";
  const workspacePath = boot?.workspacePath || "";
  const sessionId = boot?.sessionId || "mini-bot";
  const memoryPath = boot?.memoryPath || "";

  return (
    <div className="msh-desktop">
      <div className="msh-welcome-card">
        <p className="msh-welcome-kicker">{botHandle}&rsquo;s own computer</p>
        <h1>Ronic Mini Computer</h1>
        <p className="msh-welcome-sub">
          A real, isolated desktop for this bot — its own files, its own tabbed Chrome with a separate browser profile, and
          a live terminal rooted at its workspace. Nothing here touches your mouse, keyboard, or files.
        </p>
        <div className="msh-shortcuts" role="group" aria-label="Desktop application launchers">
          <button
            type="button"
            className="msh-tile"
            onClick={() => onOpen("files")}
            title={`Files — ${workspacePath}`}
            aria-label="Files"
          >
            <div className="msh-tile-icon">
              <FilesLogo size={36} />
            </div>
            <span className="msh-tile-label">Files</span>
          </button>
          <button
            type="button"
            className="msh-tile"
            onClick={() => onOpen("chrome")}
            title="Chrome — Isolated profile · tabbed"
            aria-label="Chrome"
          >
            <div className="msh-tile-icon">
              <ChromeLogo size={36} />
            </div>
            <span className="msh-tile-label">Chrome</span>
          </button>
          <button
            type="button"
            className="msh-tile"
            onClick={() => onOpen("terminal")}
            title={`Terminal — ${sessionId}`}
            aria-label="Terminal"
          >
            <div className="msh-tile-icon">
              <TerminalLogo size={36} />
            </div>
            <span className="msh-tile-label">Terminal</span>
          </button>
        </div>
        <dl className="msh-facts">
          <div>
            <dt>
              <HardDrive size={12} aria-hidden /> Workspace
            </dt>
            <dd>{workspacePath}</dd>
          </div>
          <div>
            <dt>
              <Clock size={12} aria-hidden /> Memory library
            </dt>
            <dd>{memoryPath}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
