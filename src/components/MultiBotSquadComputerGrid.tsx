import React, { useEffect, useState } from "react";
import { invokeRaw, isTauri } from "../api";
import { useRonic } from "../store";
import type { BotProfile } from "../types";

export interface SquadWindowSlot {
  slotIndex: number;
  botId: string;
  botHandle: string;
  windowLabel: string;
  urlOrTarget: string;
  driverMode: string;
  screenRect: number[];
  status: string;
}

export interface SquadBlackboardPacket {
  packetId: string;
  fromBot: string;
  toBot: string;
  topic: string;
  payloadJson: string;
  latencyMs: number;
  createdAt: number;
}

type Layout = "right_stack" | "quad_grid";

const DEFAULT_URL = "https://example.com";

function stamp(at: number): string {
  const date = new Date(at);
  return date.toTimeString().slice(0, 8);
}

export default function MultiBotSquadComputerGrid() {
  const snap = useRonic((s) => s.snap);
  const setToast = useRonic((s) => s.setToast);
  const profiles: BotProfile[] = snap?.profiles ?? [];

  const [layout, setLayout] = useState<Layout>("right_stack");
  const [slots, setSlots] = useState<SquadWindowSlot[]>([]);
  const [packets, setPackets] = useState<SquadBlackboardPacket[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(
    "Pick 2–4 bots, tile their mini-computers on the right edge, and stream packets between them — the OS clipboard and your physical mouse stay untouched."
  );

  // botId -> url for the launch form
  const [picks, setPicks] = useState<Record<string, string>>({});
  const togglePick = (id: string) => {
    setPicks((prev) => {
      const next = { ...prev };
      if (next[id] === undefined) next[id] = DEFAULT_URL;
      else delete next[id];
      return next;
    });
  };
  const pickedCount = Object.keys(picks).length;

  const [packetForm, setPacketForm] = useState({ fromBot: "", toBot: "", topic: "extracted_row", payloadJson: '{ "item_id": 1 }' });

  const refreshSlots = async () => {
    if (!isTauri()) return;
    try {
      setSlots(await invokeRaw<SquadWindowSlot[]>("squad_window_status"));
    } catch {
      /* the shell may not be ready yet */
    }
  };

  const refreshPackets = async () => {
    if (!isTauri()) return;
    try {
      setPackets(await invokeRaw<SquadBlackboardPacket[]>("list_squad_blackboard_packets", { limit: 50 }));
    } catch {
      /* first run may have no table rows yet */
    }
  };

  useEffect(() => {
    void refreshSlots();
    void refreshPackets();
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<SquadBlackboardPacket>("squad-blackboard-packet", (event) => {
        setPackets((prev) => [event.payload, ...prev].slice(0, 50));
      });
      const offLayout = await listen("ronic://squad-layout", () => {
        void refreshSlots();
      });
      if (!alive) {
        off();
        offLayout();
        return;
      }
      unlisten = () => {
        off();
        offLayout();
      };
    })();
    const timer = window.setInterval(() => void refreshSlots(), 4000);
    return () => {
      alive = false;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, []);

  const launchSquad = async () => {
    const bots = Object.entries(picks).map(([botId, url]) => {
      const profile = profiles.find((p) => p.id === botId);
      return {
        botId,
        botHandle: profile?.handle ?? `@${botId}`,
        url,
        driverMode: "Fast-CDP (<15ms)",
      };
    });
    if (bots.length < 2) {
      setToast("Squads need at least 2 bot windows.");
      return;
    }
    setBusy(true);
    try {
      const created = await invokeRaw<SquadWindowSlot[]>("launch_tiling_squad_mini_windows", { bots, layout });
      setSlots(created);
      setBanner(
        layout === "right_stack"
          ? `◫ Tiled ${created.length} bot mini-computers into the right-edge stack — each with its own cookie partition and virtual cursor.`
          : `◫ Tiled ${created.length} bot mini-computers into the 2x2 quadrant grid on the right half of the screen.`
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismissSquad = async () => {
    setBusy(true);
    try {
      const note = await invokeRaw<string>("dismiss_squad_windows");
      setBanner(note);
      setSlots([]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const publishPacket = async () => {
    if (!packetForm.fromBot || !packetForm.toBot) {
      setToast("Pick a producer and a consumer for the packet.");
      return;
    }
    setBusy(true);
    try {
      const packet = await invokeRaw<SquadBlackboardPacket>("publish_squad_blackboard_packet", {
        fromBot: packetForm.fromBot,
        toBot: packetForm.toBot,
        topic: packetForm.topic,
        payloadJson: packetForm.payloadJson,
      });
      setPackets((prev) => [packet, ...prev].slice(0, 50));
      setBanner(`⚡ ${packet.fromBot} ➔ ${packet.toBot} delivered in ${packet.latencyMs}ms over the blackboard (SQLite WAL + tokio broadcast).`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E5E5E5] rounded-[8px] p-4 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-bold tracking-tight">Simultaneous multi-bot computer matrix</h2>
            <span className={`px-2.5 py-0.5 text-[11px] font-mono font-semibold rounded-full border ${slots.length > 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-white text-[#64748B] border-[#E5E5E5]"}`}>
              {slots.length > 0 ? `● ${slots.length} mini-windows parallel` : "○ no squad running"}
            </span>
          </div>
          <p className="text-xs font-mono text-[#64748B] mt-1 max-w-xl">{banner}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setLayout(layout === "right_stack" ? "quad_grid" : "right_stack")}
            className="px-3.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 rounded-full hover:bg-slate-50 cursor-pointer shadow-xs transition"
          >
            ◫ Auto-tile ({layout === "right_stack" ? "Right stack" : "2x2 grid"})
          </button>
          <button
            onClick={() => void launchSquad()}
            disabled={busy || pickedCount < 2}
            className="px-4 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
          >
            ▶ Launch {pickedCount >= 2 ? `${pickedCount}-window squad` : "squad"}
          </button>
          <button
            onClick={() => void dismissSquad()}
            disabled={busy}
            className="px-3.5 py-1.5 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 rounded-full hover:bg-rose-100 cursor-pointer disabled:opacity-50 transition"
          >
            ✕ Dismiss all
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200/90 rounded-2xl p-5 space-y-3 shadow-xs">
          <h3 className="text-xs font-semibold border-b border-[#E5E5E5] pb-2">Squad roster ({pickedCount} picked)</h3>
          {profiles.length === 0 ? (
            <p className="text-xs text-[#64748B]">Create bots in Bots & groups first — every bot gets its own window and cookie partition.</p>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {profiles.map((profile) => (
                <div key={profile.id} className="flex items-center gap-2 text-xs">
                  <label className="flex items-center gap-1.5 w-40 shrink-0 cursor-pointer">
                    <input type="checkbox" checked={picks[profile.id] !== undefined} onChange={() => togglePick(profile.id)} />
                    <span className="font-mono font-semibold truncate">{profile.handle}</span>
                  </label>
                  {picks[profile.id] !== undefined ? (
                    <input
                      value={picks[profile.id]}
                      onChange={(e) => setPicks((prev) => ({ ...prev, [profile.id]: e.target.value }))}
                      placeholder="https://…"
                      className="flex-1 px-2 py-1 text-[11px] font-mono border border-[#E5E5E5] rounded outline-none focus:border-[#111111]"
                    />
                  ) : (
                    <span className="text-[11px] text-[#94A3B8]">persistent partition: bots/{profile.id}/browser-squad</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-[#E5E5E5] rounded-[8px] p-4 space-y-2 shadow-xs">
          <h3 className="text-xs font-semibold border-b border-[#E5E5E5] pb-2">Publish a blackboard packet</h3>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={packetForm.fromBot}
              onChange={(e) => setPacketForm({ ...packetForm, fromBot: e.target.value })}
              className="px-2 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded bg-white"
            >
              <option value="">Producer…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.handle}>{p.handle}</option>
              ))}
            </select>
            <select
              value={packetForm.toBot}
              onChange={(e) => setPacketForm({ ...packetForm, toBot: e.target.value })}
              className="px-2 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded bg-white"
            >
              <option value="">Consumer…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.handle}>{p.handle}</option>
              ))}
            </select>
          </div>
          <input
            value={packetForm.topic}
            onChange={(e) => setPacketForm({ ...packetForm, topic: e.target.value })}
            placeholder="topic (extracted_row, dom_verified…)"
            className="w-full px-2 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded outline-none focus:border-[#111111]"
          />
          <textarea
            value={packetForm.payloadJson}
            onChange={(e) => setPacketForm({ ...packetForm, payloadJson: e.target.value })}
            rows={3}
            className="w-full px-2 py-1.5 text-[11px] font-mono border border-[#E5E5E5] rounded outline-none focus:border-[#111111]"
          />
          <button
            onClick={() => void publishPacket()}
            disabled={busy}
            className="w-full py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
          >
            ⚡ Publish to squad blackboard
          </button>
        </div>
      </div>

      {slots.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {slots.map((slot) => (
            <div key={slot.windowLabel} className="bg-white border border-slate-300 rounded-2xl overflow-hidden shadow-xs">
              <div className="bg-zinc-800 text-white px-4 py-2.5 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="font-mono font-bold">#{slot.slotIndex} {slot.botHandle}</span>
                </div>
                <span className="text-[10px] font-mono text-emerald-300">{slot.driverMode}</span>
              </div>
              <div className="p-3 font-mono text-[11px] space-y-1">
                <div className="text-slate-500 truncate" title={slot.urlOrTarget}>{slot.urlOrTarget || "about:blank"}</div>
                <div className="text-slate-500">label: {slot.windowLabel}</div>
                <div className="text-slate-500">rect: [{slot.screenRect.join(", ")}]</div>
              </div>
              <div className="px-3 pb-3 pt-1">
                <button
                  onClick={() => {
                    setPicks((prev) => ({ ...prev, [slot.botId]: slot.urlOrTarget || DEFAULT_URL }));
                    setBanner(`Focused ${slot.botHandle}'s squad window — use Launch to retile.`);
                  }}
                  className="w-full py-1.5 text-xs font-semibold bg-slate-100 border border-slate-200 rounded-full hover:bg-slate-200 text-slate-700 cursor-pointer transition"
                >
                  ◫ Keep in next tiling
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="bg-white border border-slate-200/90 rounded-2xl p-5 space-y-4 shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Live inter-window squad blackboard bus</h3>
            <p className="text-xs text-slate-500 mt-0.5">tokio::sync::broadcast + squad_shared_blackboard (SQLite WAL). Producer ➔ consumer JSON, no OS clipboard.</p>
          </div>
          <span className="text-xs font-mono text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
            ● {packets.length} packets
          </span>
        </div>
        {packets.length === 0 ? (
          <p className="text-xs text-slate-400">No packets yet. Producers publish here; consumers (and this log) receive them in milliseconds.</p>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto font-mono text-[11px] pr-1">
            {packets.map((packet) => (
              <div key={packet.packetId} className="p-3 bg-slate-50 border border-slate-200/80 rounded-xl flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">{stamp(packet.createdAt)}</span>
                  <span className="px-2 py-0.5 bg-zinc-800 text-white font-bold rounded-md text-[10px]">{packet.fromBot} ➔ {packet.toBot}</span>
                  <span className="text-emerald-700 font-semibold">[{packet.topic}] ({packet.latencyMs}ms)</span>
                </div>
                <code className="text-slate-800 truncate max-w-md font-mono text-xs" title={packet.payloadJson}>{packet.payloadJson}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
