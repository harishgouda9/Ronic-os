import { useEffect, useRef, useState } from "react";
import { invokeRaw, isTauri } from "../api";
import { useRonic } from "../store";
import { botName } from "../ui/BotCoworkers";

interface MadeCopy {
  webappXmlMarkdown: string;
  sourceSurface: string;
}

/** A floating capsule. Drag it onto a chat, or click it and pick one. */
export function ContextCapsule({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const snap = useRonic((s) => s.snap);
  const [pos, setPos] = useState({ x: 280, y: 140 });
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const moved = useRef(false);
  const dragging = useRef(false);
  const grab = useRef({ x: 0, y: 0 });
  const hot = useRef<HTMLElement | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== "c") return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      event.preventDefault();
      onToggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggle]);

  useEffect(() => {
    if (!open) {
      setMenu(false);
      return;
    }
    const pane = document.querySelector("[data-pane=thread]");
    const box = pane?.getBoundingClientRect();
    if (box && box.width > 80) setPos({ x: box.left + box.width - 86, y: box.top + 64 });
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    function away(event: PointerEvent) {
      const el = event.target as HTMLElement | null;
      if (el?.closest(".ctx-cap, .ctx-menu")) return;
      setMenu(false);
    }
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [menu]);

  function clearHot() {
    hot.current?.classList.remove("ctx-hot");
    hot.current = null;
  }

  function aim(x: number, y: number) {
    let hit: HTMLElement | null = null;
    for (const node of document.elementsFromPoint(x, y)) {
      if (!(node instanceof HTMLElement) || node.closest(".ctx-cap, .ctx-menu, .ctx-note")) continue;
      hit = node.closest("[data-copy-chat], [data-copy-bot]");
      if (hit) break;
    }
    if (hit === hot.current) return;
    clearHot();
    if (hit) {
      hit.classList.add("ctx-hot");
      hot.current = hit;
    }
  }

  function chatFrom(el: HTMLElement | null): { id: string; label: string } | null {
    if (!el || !snap) return null;
    const chat = el.closest("[data-copy-chat]") as HTMLElement | null;
    const chatId = chat?.dataset.copyChat;
    if (chatId) {
      const thread = snap.threads.find((item) => item.id === chatId);
      const bot = snap.profiles.find((item) => item.id === thread?.botProfileId);
      const title = thread?.title || "Chat";
      return { id: chatId, label: bot ? `${botName(bot)} · ${title}` : title };
    }
    const botEl = el.closest("[data-copy-bot]") as HTMLElement | null;
    const botId = botEl?.dataset.copyBot;
    if (!botId) return null;
    const thread = snap.threads
      .filter((item) => item.botProfileId === botId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!thread) return null;
    const bot = snap.profiles.find((item) => item.id === botId);
    return { id: thread.id, label: `${botName(bot)} · ${thread.title || "Chat"}` };
  }

  async function capture(id: string, label: string) {
    if (busy.current) return;
    if (!isTauri()) {
      setNote("Context copy runs in the desktop app.");
      return;
    }
    busy.current = true;
    setPhase("busy");
    setMenu(false);
    setNote("Copying…");
    try {
      const made = await invokeRaw<MadeCopy>("create_context_copy", {
        sourceKind: "thread",
        sourceId: id,
        sourceLabel: label,
        goalNote: "",
      });
      try { await navigator.clipboard.writeText(made.webappXmlMarkdown); } catch { /* the copy is still saved */ }
      setPhase("done");
      setNote(`${label} is now a context.`);
      window.setTimeout(() => setPhase("idle"), 1600);
    } catch (error) {
      setPhase("idle");
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
    }
  }

  function onDown(event: React.PointerEvent<HTMLButtonElement>) {
    moved.current = false;
    dragging.current = true;
    grab.current = { x: event.clientX - pos.x, y: event.clientY - pos.y };
    setDrag(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!dragging.current) return;
    const next = {
      x: Math.max(8, Math.min(window.innerWidth - 72, event.clientX - grab.current.x)),
      y: Math.max(8, Math.min(window.innerHeight - 40, event.clientY - grab.current.y)),
    };
    if (Math.hypot(next.x - pos.x, next.y - pos.y) > 4) {
      moved.current = true;
      setMenu(false);
    }
    setPos(next);
    if (moved.current) aim(event.clientX, event.clientY);
  }

  function onUp() {
    dragging.current = false;
    setDrag(false);
    const target = chatFrom(hot.current);
    clearHot();
    if (moved.current) {
      if (target) void capture(target.id, target.label);
      return;
    }
    setMenu((openMenu) => !openMenu);
  }

  if (!open || !snap) return null;

  const activeBot = snap.threads.find((item) => item.id === snap.activeThreadId)?.botProfileId;
  const chats = [...snap.threads].sort((a, b) => {
    const aHere = a.botProfileId === activeBot ? 0 : 1;
    const bHere = b.botProfileId === activeBot ? 0 : 1;
    return aHere - bHere || b.updatedAt - a.updatedAt;
  });
  const menuLeft = Math.max(8, Math.min(pos.x - 8, window.innerWidth - 228));

  return (
    <>
      <button
        type="button"
        className={`ctx-cap${drag ? " drag" : ""}${phase === "done" ? " done" : ""}`}
        style={{ left: pos.x, top: pos.y }}
        aria-label="Copy a chat into context"
        title="Drag onto a chat, or click to choose one"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <span className="ctx-body" />
      </button>
      {note ? <span className="ctx-note" style={{ left: pos.x, top: pos.y + 42 }}>{note}</span> : null}
      {menu ? (
        <div className="ctx-menu" style={{ left: menuLeft, top: pos.y + 44 }} role="menu" aria-label="Chats">
          {chats.length === 0 ? <p>No chat yet.</p> : chats.slice(0, 12).map((item) => { /* shortcut: menu lists 12 chats; drop on a session row when there are more */
            const bot = snap.profiles.find((profile) => profile.id === item.botProfileId);
            const label = bot ? `${botName(bot)} · ${item.title || "Chat"}` : (item.title || "Chat");
            return (
              <button key={item.id} type="button" role="menuitem" data-copy-chat={item.id} disabled={phase === "busy"} onClick={() => void capture(item.id, label)}>
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
