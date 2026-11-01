import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bookmark, History, Plus, RotateCw, X } from "lucide-react";
import { ipc, errorMessage, isTauri } from "../ipc";
import { addBookmark, isBookmarked, loadBookmarks, removeBookmark, type MiniBookmark } from "../bookmarks";
import type { ShellBoot, ShellState } from "../types";

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 32);
  }
}

/**
 * The Chrome app: tab strip + toolbar live in this shell webview; the actual
 * page renders in a separate child webview that Rust positions exactly over
 * `.msh-page-area` (see App's layout reporting). Bookmarks are per bot;
 * History comes from Rust (every navigation the bot's Chrome made).
 */
export function ChromeApp({
  boot,
  shell,
  pageAreaRef,
  compact = false,
}: {
  boot: ShellBoot;
  shell: ShellState;
  pageAreaRef: React.RefObject<HTMLDivElement | null>;
  compact?: boolean;
}) {
  const active = shell.tabs.find((tab) => tab.id === shell.activeTab) ?? null;
  const [address, setAddress] = useState(active?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"none" | "bookmarks" | "history">("none");
  const [bookmarks, setBookmarks] = useState<MiniBookmark[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const botId = boot.botId;

  useEffect(() => {
    setAddress(active?.url ?? "");
  }, [active?.id, active?.url]);

  useEffect(() => {
    setBookmarks(loadBookmarks(botId));
  }, [botId, menu]);

  useEffect(() => {
    if (menu !== "history") return;
    void ipc.history(botId).then(setHistory).catch(() => setHistory([]));
  }, [menu, shell.tabs.length, active?.url, botId]);

  // Close the dropdown on any outside click / Escape.
  useEffect(() => {
    if (menu === "none") return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu("none");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu("none");
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const run = (promise: Promise<unknown>) => {
    void promise.catch((e) => setError(errorMessage(e)));
  };

  const go = (raw?: string) => {
    const target = (raw ?? address).trim();
    if (!target) return;
    const url = /^https?:\/\//i.test(target) ? target : `https://${target.replace(/^\/+/, "")}`;
    if (active) {
      run(ipc.chromeNav("address", url, botId));
    } else {
      run(ipc.openTab(url, botId));
    }
    setAddress(url);
    setMenu("none");
    addressRef.current?.blur();
  };

  const bookmarked = active ? isBookmarked(botId, active.url) : false;

  const toggleBookmark = () => {
    if (!active) return;
    setBookmarks(
      bookmarked
        ? removeBookmark(botId, active.url)
        : addBookmark(botId, { url: active.url, title: active.title || safeHost(active.url) }),
    );
  };

  return (
    <div className="msh-chrome">
      <div className="msh-tabstrip" role="tablist" aria-label="Chrome tabs">
        {shell.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === shell.activeTab}
            className={`msh-tab ${tab.id === shell.activeTab ? "on" : ""}`}
            onClick={() => run(ipc.focusTab(tab.id, botId))}
            title={tab.url}
          >
            <span className="msh-tab-title">{tab.title || safeHost(tab.url)}</span>
            <button
              className="msh-tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                run(ipc.closeTab(tab.id, botId));
              }}
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        ))}
        <button
          className="msh-tab-new"
          aria-label="New tab"
          title="New tab (Ctrl+T)"
          onClick={() => {
            addressRef.current?.focus();
            addressRef.current?.select();
            run(ipc.openTab("https://www.google.com", botId));
          }}
        >
          <Plus size={13} aria-hidden />
        </button>
      </div>
      <div className="msh-toolbar">
        <button className="msh-tool" aria-label="Back" disabled={!active} onClick={() => run(ipc.chromeNav("back", undefined, botId))}>
          <ArrowLeft size={14} aria-hidden />
        </button>
        <button className="msh-tool" aria-label="Forward" disabled={!active} onClick={() => run(ipc.chromeNav("forward", undefined, botId))}>
          <ArrowRight size={14} aria-hidden />
        </button>
        <button className="msh-tool" aria-label="Reload" disabled={!active} onClick={() => run(ipc.chromeNav("reload", undefined, botId))}>
          <RotateCw size={13} aria-hidden />
        </button>
        <input
          ref={addressRef}
          className="msh-address"
          type="text"
          placeholder="Search or type a URL"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") go();
          }}
          aria-label="Address bar"
          spellCheck={false}
        />
        <button
          className={`msh-tool ${bookmarked ? "starred" : ""}`}
          aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
          aria-pressed={bookmarked}
          title={bookmarked ? "Remove bookmark" : "Bookmark this page"}
          disabled={!active}
          onClick={toggleBookmark}
        >
          <Bookmark size={13} aria-hidden />
        </button>
        <div className="msh-drop-wrap" ref={menuRef}>
          <button
            className={`msh-tool ${menu === "bookmarks" ? "starred" : ""}`}
            aria-label="Bookmarks"
            title="Bookmarks"
            aria-expanded={menu === "bookmarks"}
            onClick={() => setMenu((current) => (current === "bookmarks" ? "none" : "bookmarks"))}
          >
            <Bookmark size={13} aria-hidden />
            {!compact ? <span style={{ fontSize: 10 }}>Saved</span> : null}
          </button>
          {menu === "bookmarks" ? (
            <div className="msh-drop" role="menu" aria-label="Bookmarks">
              <div className="msh-drop-head">
                <span>Bookmarks</span>
                <span>{bookmarks.length}</span>
              </div>
              {bookmarks.length === 0 ? (
                <p className="msh-drop-empty">No bookmarks yet — press the ☆ next to the address bar.</p>
              ) : (
                bookmarks.map((item) => (
                  <div key={item.url} style={{ display: "flex", alignItems: "center" }}>
                    <button className="msh-drop-row" onClick={() => go(item.url)} title={item.url}>
                      <Bookmark size={11} aria-hidden />
                      <span className="msh-drop-url">{item.title || safeHost(item.url)}</span>
                    </button>
                    <button
                      className="msh-drop-x"
                      aria-label={`Remove ${item.title}`}
                      onClick={() => setBookmarks(removeBookmark(botId, item.url))}
                    >
                      <X size={11} aria-hidden />
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
        <div className="msh-drop-wrap">
          <button
            className={`msh-tool ${menu === "history" ? "starred" : ""}`}
            aria-label="History"
            title="History"
            aria-expanded={menu === "history"}
            onClick={() => setMenu((current) => (current === "history" ? "none" : "history"))}
          >
            <History size={13} aria-hidden />
            {!compact ? <span style={{ fontSize: 10 }}>History</span> : null}
          </button>
          {menu === "history" ? (
            <div className="msh-drop" role="menu" aria-label="History">
              <div className="msh-drop-head">
                <span>Recent pages</span>
                <span>{history.length}</span>
              </div>
              {history.length === 0 ? (
                <p className="msh-drop-empty">Nothing yet — pages this bot visits show up here.</p>
              ) : (
                history.map((url, index) => (
                  <button key={`${url}-${index}`} className="msh-drop-row" onClick={() => go(url)} title={url}>
                    <History size={11} aria-hidden />
                    <span className="msh-drop-url">{safeHost(url)}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        <span className="msh-profile-chip" title={`Browser profile: ${boot.chromeLabel}`}>
          {boot.botHandle}
        </span>
      </div>
      <div ref={pageAreaRef} className="msh-page-area">
        {shell.tabs.length === 0 ? (
          <div className="msh-page-empty">
            <span aria-hidden>🌐</span>
            <p>No tabs yet</p>
            <span>Type an address above, or press Ctrl+T.</span>
          </div>
        ) : !isTauri() && active?.url ? (
          <iframe
            src={active.url}
            title={active.title || "Browser"}
            style={{ width: "100%", height: "100%", border: 0 }}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          />
        ) : null}
      </div>
      {error ? (
        <div className="msh-toast" role="status" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
