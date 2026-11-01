import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Box, Plus, RefreshCw, X } from "lucide-react";
import { pageHost, restartAsk, safePageUrl } from "../kernel/workspaceChrome";
import { hidePageBrowser, isTauriRuntime, pageBrowserGo, placePageBrowser, showPageBrowser, type WebAppBounds } from "../lib/tauriBridge";

const PAGE_KEY = "ronic.pageBrowser.v1";
const TEMPLATE = new Set(["http://127.0.0.1:3000/", "http://127.0.0.1:3000"]);

type PageTab = { id: string; url: string; past: string[]; future: string[] };
type PageMode = "start" | "wait" | "page" | "frame" | "refused";
type Target = { url: string; focus: boolean; reload: boolean };

function readPages(): PageTab[] {
  try {
    const raw = localStorage.getItem(PAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as { tabs?: { id?: string; url?: string }[] } : {};
    const tabs: PageTab[] = [];
    for (const tab of Array.isArray(parsed.tabs) ? parsed.tabs : []) {
      if (!tab || typeof tab.id !== "string" || typeof tab.url !== "string") continue;
      const trimmed = tab.url.trim();
      if (!trimmed) {
        tabs.push({ id: tab.id, url: "", past: [], future: [] });
        continue;
      }
      if (TEMPLATE.has(trimmed)) continue;
      const url = safePageUrl(trimmed);
      if (!url) continue;
      tabs.push({ id: tab.id, url, past: [], future: [] });
    }
    return tabs.slice(0, 6);
  } catch {
    return [];
  }
}

function writePages(tabs: PageTab[]) {
  localStorage.setItem(PAGE_KEY, JSON.stringify({ tabs: tabs.slice(0, 6).map(({ id, url }) => ({ id, url })) }));
}

function blankTab(): PageTab {
  return { id: `page-${Date.now()}`, url: "", past: [], future: [] };
}

function samePage(a: string, b: string) {
  if (a === b) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (value: string) => value.replace(/\/$/, "") || "/";
    return left.origin === right.origin && path(left.pathname) === path(right.pathname) && left.search === right.search && left.hash === right.hash;
  } catch {
    return false;
  }
}

function pageBounds(el: HTMLElement): WebAppBounds | null {
  const rect = el.getBoundingClientRect();
  let x = Math.max(0, rect.left);
  let y = Math.max(0, rect.top);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  const thread = document.querySelector("[data-pane=thread]");
  if (thread) {
    const edge = thread.getBoundingClientRect().right + 8;
    if (x < edge) x = edge;
  }
  for (const selector of ["[data-edge-rail]", "[data-jobs-panel]", ".chat-side", ".preview-col"]) {
    const neighbor = document.querySelector(selector);
    if (!neighbor || neighbor.contains(el)) continue;
    const edge = neighbor.getBoundingClientRect().left;
    if (edge > x + 8 && right > edge) right = edge;
  }
  const width = right - x;
  const height = bottom - y;
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

function boundsKey(bounds: WebAppBounds) {
  return `${Math.round(bounds.x)}|${Math.round(bounds.y)}|${Math.round(bounds.width)}|${Math.round(bounds.height)}`;
}

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  return "Could not open this page.";
}

export function LiveBrowser({ botName, onAsk, onClose }: { botName: string; onAsk: (text: string) => void; onClose: () => void }) {
  const [tabs, setTabs] = useState<PageTab[]>(() => {
    const saved = readPages();
    return saved.length ? saved : [blankTab()];
  });
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState(tabs[0]?.url ?? "");
  const [mode, setMode] = useState<PageMode>(tabs[0]?.url ? "wait" : "start");
  const [note, setNote] = useState("");
  const [nav, setNav] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(0);
  const targetRef = useRef<Target>({ url: tabs[0]?.url ?? "", focus: false, reload: false });
  const applyRef = useRef<() => void>(() => {});
  const opening = useRef(false);
  const visible = useRef(false);
  const visibleUrl = useRef("");
  const refusedUrl = useRef("");
  const placed = useRef("");
  const mounted = useRef(true);
  const current = tabs[Math.min(active, Math.max(tabs.length - 1, 0))];

  useEffect(() => {
    writePages(tabs);
  }, [tabs]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const onPage = (event: Event) => {
      const raw = (event as CustomEvent<{ url?: string }>).detail?.url;
      const next = raw ? safePageUrl(raw) : null;
      const expected = targetRef.current.url;
      if (!next || !expected) return;
      const index = activeRef.current;
      setTabs((items) => items.map((tab, item) => {
        if (item !== index) return tab;
        if (!tab.url || samePage(tab.url, next)) return tab.url === next ? tab : { ...tab, url: next };
        return { ...tab, url: next, past: [...tab.past, tab.url].slice(-30), future: [] };
      }));
      if (document.activeElement !== inputRef.current) setDraft(next);
    };
    window.addEventListener("ronic-page", onPage);
    return () => window.removeEventListener("ronic-page", onPage);
  }, []);

  applyRef.current = () => {
    const wanted = targetRef.current;
    const slot = frameRef.current;
    if (!isTauriRuntime()) {
      setMode(wanted.url ? "frame" : "start");
      return;
    }
    if (!wanted.url) {
      visible.current = false;
      visibleUrl.current = "";
      refusedUrl.current = "";
      placed.current = "";
      setMode("start");
      void hidePageBrowser();
      return;
    }
    const bounds = slot ? pageBounds(slot) : null;
    if (!wanted.reload && refusedUrl.current === wanted.url) return;
    if (!wanted.reload && visible.current && visibleUrl.current === wanted.url) {
      if (!bounds) return;
      const key = boundsKey(bounds);
      if (placed.current === key) return;
      placed.current = key;
      void placePageBrowser(bounds).catch(() => {});
      return;
    }
    if (opening.current || !bounds) return;
    const asked = wanted.url;
    const focus = wanted.focus;
    const reload = wanted.reload;
    opening.current = true;
    if (visibleUrl.current !== asked) setMode("wait");
    void showPageBrowser(bounds, asked, focus).then((res) => {
      opening.current = false;
      if (!mounted.current) {
        void hidePageBrowser();
        return;
      }
      if (targetRef.current.url !== asked) {
        applyRef.current();
        return;
      }
      targetRef.current.focus = false;
      targetRef.current.reload = false;
      if (res.refused) {
        visible.current = false;
        visibleUrl.current = "";
        refusedUrl.current = asked;
        placed.current = "";
        setMode("refused");
        return;
      }
      refusedUrl.current = "";
      visible.current = true;
      visibleUrl.current = asked;
      const now = frameRef.current ? pageBounds(frameRef.current) : null;
      if (now) {
        placed.current = boundsKey(now);
        if (boundsKey(now) !== boundsKey(bounds)) void placePageBrowser(now).catch(() => {});
      }
      setMode("page");
      setNote("");
      if (reload) void pageBrowserGo("reload").catch((error) => setNote(errorText(error)));
    }).catch((error) => {
      opening.current = false;
      if (!mounted.current) {
        void hidePageBrowser();
        return;
      }
      if (targetRef.current.url !== asked) {
        applyRef.current();
        return;
      }
      visible.current = false;
      setNote(errorText(error));
    });
  };

  useEffect(() => {
    mounted.current = true;
    const run = () => applyRef.current();
    const observer = new ResizeObserver(run);
    const watch = (selector: string) => {
      const node = document.querySelector(selector);
      if (node) observer.observe(node);
    };
    if (frameRef.current) observer.observe(frameRef.current);
    const parent = frameRef.current?.closest(".chat-layout, .chat-grid");
    if (parent) observer.observe(parent);
    watch("[data-pane=thread]");
    watch("[data-edge-rail]");
    watch("[data-jobs-panel]");
    watch(".chat-side");
    watch(".preview-col");
    let frame2 = 0;
    const frame = requestAnimationFrame(() => {
      run();
      frame2 = requestAnimationFrame(run);
    });
    const later = window.setTimeout(run, 120);
    window.addEventListener("resize", run);
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(frame2);
      window.clearTimeout(later);
      observer.disconnect();
      window.removeEventListener("resize", run);
      void hidePageBrowser();
    };
  }, []);

  useEffect(() => {
    applyRef.current();
  }, [nav]);

  function visit(url: string, focus: boolean, reload: boolean) {
    targetRef.current = { url, focus, reload };
    refusedUrl.current = "";
    setNav((value) => value + 1);
  }

  function go(raw: string, push: boolean, focus: boolean) {
    const next = safePageUrl(raw);
    if (!next) {
      setNote("Use an https address, or http://localhost.");
      return;
    }
    setNote("");
    const tab = tabs[active];
    if (!tab) return;
    const same = Boolean(tab.url) && samePage(tab.url, next);
    setTabs((items) => items.map((item, index) => {
      if (index !== active) return item;
      if (!push || same || !item.url) return { ...item, url: next };
      return { ...item, url: next, past: [...item.past, item.url].slice(-30), future: [] };
    }));
    setDraft(next);
    visit(next, focus, same);
  }

  function select(index: number) {
    const url = tabs[index]?.url ?? "";
    setActive(index);
    activeRef.current = index;
    setDraft(url);
    setNote("");
    visit(url, false, false);
  }

  function addTab() {
    if (tabs.length >= 6) return;
    const tab = blankTab();
    const index = tabs.length;
    setTabs((items) => [...items, tab]);
    setActive(index);
    activeRef.current = index;
    setDraft("");
    setNote("");
    visit("", false, false);
  }

  function closeTab(index: number) {
    if (tabs.length === 1) {
      onClose();
      return;
    }
    const next = tabs.filter((_, item) => item !== index);
    const nextActive = Math.max(0, Math.min(index < active ? active - 1 : active, next.length - 1));
    setTabs(next);
    setActive(nextActive);
    activeRef.current = nextActive;
    const url = next[nextActive]?.url ?? "";
    setDraft(url);
    setNote("");
    visit(url, false, false);
  }

  function back() {
    const tab = tabs[active];
    if (!tab || tab.past.length === 0) return;
    const previous = tab.past[tab.past.length - 1] ?? "";
    setTabs((items) => items.map((item, index) => index === active ? { ...item, url: previous, past: item.past.slice(0, -1), future: item.url ? [item.url, ...item.future] : item.future } : item));
    setDraft(previous);
    visit(previous, false, false);
  }

  function forward() {
    const tab = tabs[active];
    const next = tab?.future[0];
    if (!tab || !next) return;
    setTabs((items) => items.map((item, index) => index === active ? { ...item, url: next, past: item.url ? [...item.past, item.url].slice(-30) : item.past, future: item.future.slice(1) } : item));
    setDraft(next);
    visit(next, false, false);
  }

  function reload() {
    const url = tabs[active]?.url ?? "";
    if (!url) return;
    visit(url, false, true);
  }

  const label = current?.url ? pageHost(current.url) : "New tab";

  return (
    <aside className="pane page-browser" data-page-browser>
      <div className="page-tabs">
        {tabs.map((tab, index) => (
          <div key={tab.id} className={`page-tab ${index === active ? "on" : ""}`}>
            <button type="button" onClick={() => select(index)}>{tab.url ? pageHost(tab.url) : "New tab"}</button>
            <button type="button" aria-label="Close page" onClick={() => closeTab(index)}><X size={12} /></button>
          </div>
        ))}
        <button type="button" className="page-add" aria-label="New page" onClick={addTab} disabled={tabs.length >= 6}><Plus size={14} /></button>
      </div>
      <form
        className="page-bar"
        onSubmit={(event) => {
          event.preventDefault();
          go(draft, true, true);
        }}
      >
        <button type="button" aria-label="Back" disabled={!current || current.past.length === 0} onClick={back}><ArrowLeft size={14} /></button>
        <button type="button" aria-label="Forward" disabled={!current || current.future.length === 0} onClick={forward}><ArrowRight size={14} /></button>
        <button type="button" aria-label="Reload page" disabled={!current?.url} onClick={reload}><RefreshCw size={14} /></button>
        <input ref={inputRef} aria-label="Page address" value={draft} placeholder="https:// or localhost:3000" onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
      </form>
      {note ? <p className="muted page-wait">{note}</p> : null}
      <div className="page-frame" ref={frameRef} data-page-frame>
        {mode === "refused" && current?.url ? (
          <div className="page-error" data-page-error>
            <Box size={42} strokeWidth={1.2} />
            <strong>Server not found</strong>
            <span>{label}</span>
            <span className="mono">ERR_CONNECTION_REFUSED</span>
            <button type="button" className="btn" onClick={reload}>Try again</button>
            <button type="button" className="text-btn" onClick={() => onAsk(restartAsk(current.url))}>Ask {botName} to restart the server</button>
          </div>
        ) : mode === "start" ? (
          <div className="page-start">
            <strong>Browser</strong>
            <span>Type an https address, or http://localhost, and press Enter.</span>
          </div>
        ) : mode === "frame" && current?.url ? (
          <iframe key={`${current.url}-${nav}`} title={label} src={current.url} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" />
        ) : mode === "wait" && !note ? (
          <p className="muted page-wait">Opening this page.</p>
        ) : null}
      </div>
    </aside>
  );
}
