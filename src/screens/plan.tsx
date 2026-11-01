import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight,
  Check,
  Cloud,
  CreditCard,
  KeyRound,
  Laptop,
  ShieldCheck,
  Sparkles,
  Star,
  Zap,
} from "lucide-react";
import { useRonic } from "../store";
import { AccountPanel } from "../ui/AccountPanel";
import { isTauriRuntime } from "../lib/tauriBridge";
import {
  cloudConfig,
  cloudSession,
  refreshLicense,
  registerThisDevice,
  signInWithBrowser,
  startProductCheckout,
  subscribeCloud,
} from "../services/cloud";
import { money } from "../ui/bits";
import type { Provider, Settings, Snapshot } from "../types";

type TabId = "plans" | "account" | "vault" | "mesh" | "checklist";

const TABS: [TabId, string][] = [
  ["plans", "Plans & benefits"],
  ["account", "Account & machines"],
  ["vault", "API key vault"],
  ["mesh", "1-click MCP setup"],
  ["checklist", "Setup checklist"],
];

type MeshApp = {
  id: string;
  name: string;
  kind: string;
  protocol: string;
  authStatus: string;
  endpoint: string;
  installed: boolean;
  autoConnected: boolean;
};

type MeshStatus = {
  autoConnectOnAuth: boolean;
  codeModeOn: boolean;
  mcpEndpoint: string;
  acpEndpoint: string;
  note: string;
  dtsTokens: number;
  rawSchemaTokens: number;
  apps: MeshApp[];
};

/* ── Marketplace design-system atoms ─────────────────────────────── */

function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "emerald" | "amber" | "rose" | "blue" | "purple" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
    amber: "bg-amber-50 text-amber-700 border-amber-200/80",
    rose: "bg-rose-50 text-rose-700 border-rose-200/80",
    blue: "bg-blue-50 text-blue-700 border-blue-200/80",
    purple: "bg-purple-50 text-purple-700 border-purple-200/80",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${tones[tone]}`}>
      {children}
    </span>
  );
}

const inputCls =
  "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

export function PlanHub() {
  const snap = useRonic((s) => s.snap)!;
  const session = useSyncExternalStore(subscribeCloud, cloudSession, () => null);
  const [tab, setTab] = useState<TabId>("plans");
  const license = snap.license;
  const founder = license?.planTier === "founder_lifetime";
  const pro = license?.planTier === "pro" || founder;

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">

        {/* ─── HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Plan &amp; setup</h1>
                {founder && license?.founderBadge ? (
                  <Chip tone="amber"><Star size={9} /> FOUNDER #{license.founderBadge}</Chip>
                ) : (
                  <Chip tone={license ? "emerald" : "slate"}>{license ? tierLabel(license.planTier, license.founderBadge).toUpperCase() : "STARTER"}</Chip>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1.5 max-w-2xl leading-relaxed">
                {license
                  ? `${tierLabel(license.planTier, license.founderBadge)} · ${licenseStatusLabel(license.status)}`
                  : "Core local features are free forever. Sign in to register this machine and unlock cloud plans."}
              </p>
            </div>
          </div>

          {/* ─── TABS ─── */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                  tab === id
                    ? "bg-zinc-800 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── BODY ─── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-7">
          {tab === "plans" ? <PlansTab snap={snap} signedIn={Boolean(session)} founder={founder} pro={pro} /> : null}
          {tab === "account" ? <AccountPanel /> : null}
          {tab === "vault" ? <VaultTab providers={snap.providers} /> : null}
          {tab === "mesh" ? <MeshTab /> : null}
          {tab === "checklist" ? <ChecklistTab snap={snap} signedIn={Boolean(session)} setTab={setTab} /> : null}
        </div>

        {/* ─── FOOTER STATUS BAR ─── */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2 truncate pr-4">
            <span className={`w-2 h-2 rounded-full shrink-0 ${cloudConfig.supabase ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span className="truncate">
              {cloudConfig.supabase
                ? "Account cloud configured — sign in to sync plans across machines"
                : "Account cloud not configured — local registration is used on this machine"}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span className="font-mono">checkout {cloudConfig.checkoutApi ? "on" : "off"}</span>
            <span>·</span>
            <span className="font-mono">lease signer {cloudConfig.lease ? "on" : "off"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlansTab({ snap, signedIn, founder, pro }: { snap: Snapshot; signedIn: boolean; founder: boolean; pro: boolean }) {
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const settings = snap.settings;
  const license = snap.license;
  const walletUsd = (license?.walletMicroUsd ?? 0) / 1_000_000;
  const [note, setNote] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  function save(next: Settings) {
    void run("save_settings", { settings: next });
  }

  async function signInAndRegister() {
    setAuthBusy(true);
    setNote("Opening browser sign-in…");
    try {
      const message = await signInWithBrowser("github");
      if (message) {
        setNote(message);
        return;
      }
      setNote("Signed in. Registering this machine…");
      const registered = await registerThisDevice();
      if (registered) {
        setNote(registered);
        return;
      }
      const refreshed = await refreshLicense();
      setNote(refreshed || "Machine registered and license refreshed.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function checkout(product: "founder_pass" | "pro_monthly" | "pro_yearly", rail: "stripe" | "razorpay") {
    if (!signedIn) {
      setNote("Sign in first — the plan lands on your account after payment.");
      return;
    }
    setNote("Starting checkout…");
    const { error, checkout: started } = await startProductCheckout(product, rail);
    if (error || !started) {
      setNote(error ?? "Checkout did not start.");
      return;
    }
    if (started.kind === "stripe") {
      try {
        await invoke("open_system_url", { url: started.url });
        setNote("Checkout opened in your browser. The plan lands on your account after payment.");
      } catch (error) {
        setNote(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    setNote(`Razorpay order ${started.orderId} created (₹${(started.amountPaise / 100).toFixed(0)}). Finish it from the Razorpay page with key ${started.keyId}.`);
  }

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="w-8 h-8 rounded-xl border flex items-center justify-center bg-slate-50 text-slate-500 border-slate-100">
              <ShieldCheck size={14} />
            </span>
            <Chip tone={license && (license.status === "active" || license.status === "local") ? "emerald" : "amber"}>
              {license?.status === "active" ? "MACHINE REGISTERED" : license?.status === "local" ? "REGISTERED (LOCAL)" : "UNREGISTERED"}
            </Chip>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-slate-500">Your plan</p>
            <p className="text-xl font-bold text-slate-900 tracking-tight mt-0.5">{license ? tierLabel(license.planTier, license.founderBadge) : "Starter"}</p>
          </div>
          <p className="text-[10.5px] text-slate-400 leading-relaxed">
            {license?.status === "active"
              ? `Lease verified · ${license.maxDevices} machine${license.maxDevices === 1 ? "" : "s"} · renews ${new Date(license.leaseExpUnix * 1000).toLocaleDateString()}`
              : license?.status === "local"
                ? "Registered on this machine (local, offline). Cloud plans activate once sign-in is configured."
                : license?.status === "unsigned_dev"
                  ? "Development build — every feature is open and nothing is enforced."
                  : signedIn
                    ? "Signed in. Register this machine to activate its lease."
                    : "Core local features are free forever. Register this machine — no account needed."}
          </p>
          {license?.status === "active" ? null : cloudConfig.supabase ? (
            signedIn ? (
              <button
                type="button"
                disabled={authBusy}
                onClick={() => {
                  setAuthBusy(true);
                  void registerThisDevice().then(async (registered) => {
                    if (registered) {
                      setNote(registered);
                    } else {
                      setNote((await refreshLicense()) || "Machine registered and license refreshed.");
                    }
                    setAuthBusy(false);
                  });
                }}
                className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Register this machine
              </button>
            ) : (
              <button
                type="button"
                disabled={authBusy}
                onClick={() => void signInAndRegister()}
                className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                {authBusy ? "Signing in…" : "Sign in & register machine"}
              </button>
            )
          ) : license?.status === "local" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("unregister_local_machine", {})}
              className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
            >
              Unregister this machine
            </button>
          ) : license?.status !== "unsigned_dev" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("register_local_machine", {})}
              className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
            >
              Register this machine (local · 1-click)
            </button>
          ) : null}
        </article>

        <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="w-8 h-8 rounded-xl border flex items-center justify-center bg-blue-50 text-blue-600 border-blue-100">
              <Zap size={14} />
            </span>
            <span className="text-[10px] font-medium text-slate-400">pay-as-you-go</span>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-slate-500">Burst credits</p>
            <p className="text-xl font-bold text-slate-900 tracking-tight font-mono mt-0.5">{money(settings.burstCreditsUsd)}</p>
          </div>
          <p className="text-[10.5px] text-slate-400 leading-relaxed">
            Cloud wallet {money(walletUsd)}. Used when your flat-rate subscriptions all hit their limits at once.
          </p>
        </article>

        <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="w-8 h-8 rounded-xl border flex items-center justify-center bg-purple-50 text-purple-600 border-purple-100">
              <Cloud size={14} />
            </span>
            <span className="text-[10px] font-medium text-slate-400">cloud microVM</span>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-slate-500">24/7 ghost runners</p>
            <p className="text-xl font-bold text-slate-900 tracking-tight mt-0.5">{settings.ghostRunners.length > 0 ? `${settings.ghostRunners.length} active` : "None"}</p>
          </div>
          <p className="text-[10.5px] text-slate-400 leading-relaxed">
            {settings.ghostRunners.length > 0
              ? settings.ghostRunners.join(", ")
              : "Runners keep bots and routines alive with the lid closed. Provisioning opens when the runner service ships on your account."}
          </p>
        </article>
      </div>

      {/* Plan picker */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-2 flex-wrap">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Choose your plan &amp; feature access</h2>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Chip tone={cloudConfig.supabase ? "emerald" : "amber"}>account cloud: {cloudConfig.supabase ? "configured" : "not configured — local registration used"}</Chip>
            <Chip tone={cloudConfig.checkoutApi ? "emerald" : "amber"}>checkout: {cloudConfig.checkoutApi ? "configured" : "not configured"}</Chip>
            <Chip tone={cloudConfig.lease ? "emerald" : "amber"}>lease signer: {cloudConfig.lease ? "configured" : "not configured"}</Chip>
            {snap.license?.proEntitled ? <Chip tone="emerald">Pro features: unlocked</Chip> : <Chip tone="slate">Pro features: locked</Chip>}
          </div>
        </div>
        <p className="text-[11px] text-slate-500 px-2">
          Local single-player power is free forever. Paid plans add automatic failover, squads, and multi-machine sync — never a markup on your own subscriptions.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Starter */}
          <article className={`bg-white rounded-2xl p-5 shadow-xs space-y-3 border transition-all ${!pro ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200/80"}`}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Ronic Starter</h3>
              <Chip tone={pro ? "slate" : "emerald"}>{pro ? "included" : "current"}</Chip>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 tracking-tight">$0</p>
              <p className="text-[11px] text-slate-400">free forever · ₹0</p>
            </div>
            <ul className="space-y-1.5 text-[11.5px] text-slate-600">
              <li className="flex items-start gap-1.5"><Check size={12} className="text-emerald-500 mt-0.5 shrink-0" /> Link Claude, ChatGPT, Gemini, Grok &amp; local CLIs — no markup</li>
              <li className="flex items-start gap-1.5"><Check size={12} className="text-emerald-500 mt-0.5 shrink-0" /> Mem0 local memory vault + Obsidian sync</li>
              <li className="flex items-start gap-1.5"><Check size={12} className="text-emerald-500 mt-0.5 shrink-0" /> 1-click MCP &amp; ACP mesh for IDEs, CLIs and web apps</li>
              <li className="flex items-start gap-1.5"><Check size={12} className="text-emerald-500 mt-0.5 shrink-0" /> Terminal, git diff viewer, skills &amp; plugins</li>
              <li className="flex items-start gap-1.5"><Check size={12} className="text-emerald-500 mt-0.5 shrink-0" /> Original bots on your subscriptions + 3 manual Supercharge runs/day</li>
              <li className="flex items-start gap-1.5"><Check size={12} className="text-emerald-500 mt-0.5 shrink-0" /> Sandbox wallet ledger (no live charges)</li>
            </ul>
          </article>

          {/* Pro */}
          <article className={`bg-white rounded-2xl p-5 shadow-xs space-y-3 border transition-all ${pro && !founder ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200/80"}`}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Ronic Pro</h3>
              {founder ? <Chip tone="emerald">★ included for life</Chip> : snap.license?.proEntitled ? <Chip tone="emerald">active</Chip> : null}
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 tracking-tight">$14/mo</p>
              <p className="text-[11px] text-slate-400">or $120/yr · ₹999/mo UPI</p>
            </div>
            <ul className="space-y-1.5 text-[11.5px] text-slate-600">
              <li className="flex items-start gap-1.5"><Zap size={12} className="text-amber-500 mt-0.5 shrink-0" /> &lt;50ms auto-failover when a 5-hour cap hits mid-task</li>
              <li className="flex items-start gap-1.5"><Sparkles size={12} className="text-purple-500 mt-0.5 shrink-0" /> Unlimited multi-bot squads &amp; unattended routines</li>
              <li className="flex items-start gap-1.5"><Sparkles size={12} className="text-purple-500 mt-0.5 shrink-0" /> Unlimited Auto Supercharge (Harness²)</li>
              <li className="flex items-start gap-1.5"><Sparkles size={12} className="text-purple-500 mt-0.5 shrink-0" /> All memory engines (Zep, Cognee, Letta + shadow sync)</li>
              <li className="flex items-start gap-1.5"><CreditCard size={12} className="text-blue-500 mt-0.5 shrink-0" /> Live financial rails with the Rust policy guard</li>
              <li className="flex items-start gap-1.5"><Laptop size={12} className="text-slate-500 mt-0.5 shrink-0" /> 3 concurrent machines</li>
            </ul>
            {!founder ? (
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={!signedIn}
                  title={signedIn ? undefined : "Sign in first."}
                  onClick={() => void checkout("pro_monthly", "stripe")}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                >
                  $14/mo card
                </button>
                <button
                  type="button"
                  disabled={!signedIn}
                  onClick={() => void checkout("pro_monthly", "razorpay")}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                >
                  ₹999 UPI
                </button>
              </div>
            ) : null}
          </article>

          {/* Founder */}
          <article className={`rounded-2xl p-5 shadow-xs space-y-3 border transition-all ${
            founder
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white border-slate-200/80"
          }`}>
            <div className="flex items-center justify-between">
              <h3 className={`text-sm font-bold ${founder ? "text-white" : "text-slate-900"}`}>Founder Pass ★</h3>
              {founder && license?.founderBadge ? <Chip tone="amber">#{license.founderBadge}</Chip> : null}
            </div>
            <div>
              <p className={`text-2xl font-bold tracking-tight ${founder ? "text-white" : "text-slate-900"}`}>$149 once</p>
              <p className={`text-[11px] ${founder ? "text-slate-400" : "text-slate-400"}`}>₹11,999 · lifetime · 500 total</p>
            </div>
            <ul className={`space-y-1.5 text-[11.5px] ${founder ? "text-slate-300" : "text-slate-600"}`}>
              <li className="flex items-start gap-1.5"><Star size={12} className="text-amber-400 mt-0.5 shrink-0" /> Everything in Pro, forever — no renewals</li>
              <li className="flex items-start gap-1.5"><Star size={12} className="text-amber-400 mt-0.5 shrink-0" /> Permanent founder badge</li>
              <li className="flex items-start gap-1.5"><Star size={12} className="text-amber-400 mt-0.5 shrink-0" /> $10 burst credits on activation</li>
              <li className="flex items-start gap-1.5"><Star size={12} className="text-amber-400 mt-0.5 shrink-0" /> 3 machines (Windows, macOS, Linux)</li>
              <li className="flex items-start gap-1.5"><Star size={12} className="text-amber-400 mt-0.5 shrink-0" /> All future core updates</li>
            </ul>
            {!founder ? (
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={!signedIn}
                  title={signedIn ? undefined : "Sign in first."}
                  onClick={() => void checkout("founder_pass", "stripe")}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                >
                  Claim — $149
                </button>
                <button
                  type="button"
                  disabled={!signedIn}
                  onClick={() => void checkout("founder_pass", "razorpay")}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                >
                  ₹11,999 UPI
                </button>
              </div>
            ) : null}
          </article>
        </div>

        <article className="bg-slate-50/50 rounded-3xl p-4 border border-slate-100/80 flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Cloud size={14} className="text-purple-500" />
              <h3 className="text-xs font-bold text-slate-800">24/7 ghost runners</h3>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed max-w-2xl">
              A cloud microVM keeps your bots and scheduled routines running while this laptop sleeps, with stdout and memory syncing back on wake. Billing for runners goes live with the runner service — nothing is charged today.
            </p>
          </div>
          <span className="text-[11px] font-mono text-slate-400 shrink-0">$19/mo per runner · or $0.008/hr</span>
        </article>
        {note ? <p className="text-xs text-slate-500 px-2">{note}</p> : null}
      </div>

      {/* System */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">System</h2>
        </div>
        <div className="bg-slate-50/50 rounded-3xl p-4 border border-slate-100/80 space-y-3">
          <label className="space-y-1 block max-w-sm">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Update channel</span>
            <select
              className={inputCls}
              value={settings.updateChannel}
              onChange={(event) => save({ ...settings, updateChannel: event.target.value as Settings["updateChannel"] })}
            >
              <option value="stable">stable — signed releases</option>
              <option value="nightly">nightly — newest builds</option>
            </select>
          </label>
          <div className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-white border border-slate-200/80">
            <div>
              <p className="text-xs font-semibold text-slate-800">Live financial rails</p>
              <p className="text-[11px] text-slate-400">Real charges stay physically disabled in this build.</p>
            </div>
            <button
              type="button"
              onClick={() => save({ ...settings, liveRails: !settings.liveRails })}
              className={`text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all cursor-pointer active:scale-95 ${
                settings.liveRails
                  ? "bg-rose-50 text-rose-600 border border-rose-200"
                  : "bg-emerald-50 text-emerald-700 border border-emerald-200/80"
              }`}
            >
              {settings.liveRails ? "on — charges refused in this build" : "off — sandbox ledger"}
            </button>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Installed {settings.version}. {settings.availableVersion === settings.version ? "You are up to date." : `Listed update ${settings.availableVersion}.`} Live rails need a processor key configured before they can move real money; without one, wallet actions fail closed.
          </p>
        </div>
      </div>
    </>
  );
}

function VaultTab({ providers }: { providers: Provider[] }) {
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");
  const [verify, setVerify] = useState<Record<string, number> | null>(null);
  const [verifying, setVerifying] = useState(false);
  const withKeys = providers.filter((provider) => provider.hasSecret);
  const desktop = isTauriRuntime();

  async function verifyAll() {
    if (!desktop) return;
    setVerifying(true);
    setNote("Checking every stored key against its service…");
    try {
      const list = await invoke<{ models: { providerId: string }[]; notes: string[] }>("list_provider_models");
      const counts: Record<string, number> = {};
      for (const model of list.models) counts[model.providerId] = (counts[model.providerId] ?? 0) + 1;
      setVerify(counts);
      setNote(list.notes.length > 0 ? list.notes.join(" · ") : `Checked ${withKeys.length} key${withKeys.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">API key vault</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Keys live in the encrypted local vault, never in plaintext. They are used for in-chat replies and never shown again after saving.
          </p>
        </div>
        <button
          type="button"
          disabled={!desktop || verifying || withKeys.length === 0}
          title={desktop ? undefined : "Key checks run in the desktop app."}
          onClick={() => void verifyAll()}
          className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
        >
          {verifying ? "Checking…" : "Test stored keys"}
        </button>
      </div>
      <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all duration-150">
            <div className="flex items-center gap-4 min-w-0 pr-3">
              <div className={`w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center border ${
                provider.hasSecret ? "bg-emerald-50 text-emerald-600 border-emerald-100" : "bg-slate-50 text-slate-400 border-slate-100"
              }`}>
                <KeyRound size={15} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-800">{provider.name}</span>
                  <Chip tone={provider.hasSecret ? "emerald" : "slate"}>
                    {provider.hasSecret ? `vault${verify && verify[provider.id] !== undefined ? ` · ${verify[provider.id]} models` : ""}` : "not set"}
                  </Chip>
                </div>
                <p className="text-[11px] text-slate-500 truncate">{provider.healthDetail || provider.providerType}</p>
              </div>
            </div>
            {editing === provider.id ? (
              <div className="shrink-0 flex items-center gap-2">
                <input
                  type="password"
                  placeholder="paste key"
                  value={secret}
                  autoComplete="off"
                  onChange={(event) => setSecret(event.target.value)}
                  className="px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-900 outline-none focus:border-black focus:ring-2 focus:ring-black/5 w-48"
                />
                <button
                  type="button"
                  disabled={busy || secret.trim().length === 0}
                  onClick={() => {
                    void run("set_provider_secret", { id: provider.id, secret }).then((res) => {
                      if (res) setEditing(null);
                      setSecret("");
                    });
                  }}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(null); setSecret(""); }}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(provider.id)}
                className="shrink-0 text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
              >
                {provider.hasSecret ? "Rotate key" : "Add key"}
              </button>
            )}
          </div>
        ))}
      </div>
      {note ? <p className="text-xs text-slate-500 px-2">{note}</p> : null}
    </div>
  );
}

function MeshTab() {
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const desktop = isTauriRuntime();

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void invoke<MeshStatus>("mesh_status").then((next) => {
      if (alive) setStatus(next);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [desktop]);

  async function connectAll() {
    setBusy(true);
    try {
      const next = await invoke<MeshStatus>("mesh_connect_all");
      setStatus(next);
      setNote(next.note);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function setFlag(patch: { autoConnectOnAuth?: boolean; codeModeOn?: boolean }) {
    setBusy(true);
    try {
      const next = await invoke<MeshStatus>("mesh_set_flags", patch);
      setStatus(next);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!desktop) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-2">1-click MCP &amp; ACP setup</h2>
        <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80">
          <div className="py-14 text-center space-y-2">
            <p className="text-sm font-semibold text-slate-700">The mesh runs in the desktop app</p>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">Open Ronic OS on the desktop to auto-link IDEs, CLIs, and web apps.</p>
          </div>
        </div>
      </div>
    );
  }

  const apps = status?.apps ?? [];
  const linked = apps.filter((app) => app.autoConnected).length;
  const saved = status && status.rawSchemaTokens > 0 ? Math.max(0, 100 - Math.round((status.dtsTokens / status.rawSchemaTokens) * 100)) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">1-click MCP &amp; ACP setup</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Links your installed IDEs, coding CLIs, and web apps to this workspace's memory, skills, and tools. Free forever.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void connectAll()}
          className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
        >
          {busy ? "Connecting…" : "Connect everything"}
        </button>
      </div>
      {status ? (
        <div className="flex items-center gap-2 px-2 flex-wrap">
          <Chip tone={status.autoConnectOnAuth ? "emerald" : "slate"}>auto-connect on sign-in: {status.autoConnectOnAuth ? "on" : "off"}</Chip>
          <Chip tone={status.codeModeOn ? "emerald" : "slate"}>code mode: {status.codeModeOn ? "on" : "off"}</Chip>
          {saved > 0 ? <Chip tone="blue">schema tokens −{saved}%</Chip> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void setFlag({ autoConnectOnAuth: !status.autoConnectOnAuth })}
            className="text-[11px] font-semibold px-3 py-1 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
          >
            Toggle auto-connect
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void setFlag({ codeModeOn: !status.codeModeOn })}
            className="text-[11px] font-semibold px-3 py-1 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
          >
            Toggle code mode
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-500 px-2">Reading mesh status…</p>
      )}
      {status ? <p className="text-[10px] text-slate-400 font-mono px-2">{status.mcpEndpoint} · {status.acpEndpoint}</p> : null}
      <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
        {apps.map((app) => (
          <div key={app.id} className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all duration-150">
            <div className="flex items-center gap-4 min-w-0 pr-3">
              <div className={`w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center border ${
                app.autoConnected ? "bg-emerald-50 text-emerald-600 border-emerald-100" : "bg-slate-50 text-slate-400 border-slate-100"
              }`}>
                <Laptop size={15} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-800">{app.name}</span>
                  <Chip tone={app.autoConnected ? "emerald" : app.installed ? "slate" : "amber"}>
                    {app.autoConnected ? "linked" : app.installed ? "ready" : "not installed"}
                  </Chip>
                </div>
                <p className="text-[11px] text-slate-500 truncate font-mono">{app.protocol}</p>
                <p className="text-[10px] text-slate-400 truncate">{app.authStatus}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      {apps.length > 0 ? <p className="text-[11px] text-slate-400 px-2">{linked} of {apps.length} surfaces linked.</p> : null}
      {note ? <p className="text-xs text-slate-500 px-2">{note}</p> : null}
    </div>
  );
}

function ChecklistTab({ snap, signedIn, setTab }: { snap: Snapshot; signedIn: boolean; setTab: (tab: TabId) => void }) {
  const license = snap.license;
  const detected = snap.scan?.found ?? [];
  const withKeys = snap.providers.filter((provider) => provider.hasSecret);
  const bots = snap.profiles.filter((profile) => profile.engineKind === "openai_api" || profile.engineKind === "subscription" || profile.commandOrUrl);
  const rows: { step: string; detail: string; done: boolean; tab: TabId }[] = [
    {
      step: "1. Link your tools",
      detail: detected.length > 0 ? `${detected.length} found on this machine: ${detected.slice(0, 4).map((hit) => hit.name).join(", ")}${detected.length > 4 ? "…" : ""}.` : "Run the tool scan from Settings to detect your CLIs and IDEs.",
      done: detected.length > 0,
      tab: "mesh",
    },
    {
      step: "2. Turn on the MCP mesh",
      detail: "One click links IDEs, CLIs, and web apps to memory and skills.",
      done: false,
      tab: "mesh",
    },
    {
      step: "3. Add a key or use your subscriptions",
      detail: withKeys.length > 0 ? `${withKeys.length} key${withKeys.length === 1 ? "" : "s"} in the vault (${withKeys.slice(0, 3).map((provider) => provider.name).join(", ")}${withKeys.length > 3 ? "…" : ""}).` : "Paste one API key, or use subscription bots (ChatGPT plan, Claude Code, Gemini CLI) with no key at all.",
      done: withKeys.length > 0 || bots.length > 0,
      tab: "vault",
    },
    {
      step: "4. Register this machine",
      detail:
        license?.status === "active"
          ? `Registered · lease renews ${new Date(license.leaseExpUnix * 1000).toLocaleDateString()}.`
          : license?.status === "local"
            ? "Registered locally (free Starter plan) — works offline, no account needed."
            : license?.status === "unsigned_dev"
              ? "Development build — registration is not required."
              : "One click registers this machine locally; cloud sign-in is optional.",
      done: Boolean(license && (license.status === "active" || license.status === "local" || license.status === "unsigned_dev")),
      tab: "plans",
    },
  ];
  const doneCount = rows.filter((row) => row.done).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">60-second setup</h2>
        <Chip tone={doneCount === rows.length ? "emerald" : "slate"}>{doneCount}/{rows.length} done</Chip>
      </div>
      <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
        {rows.map((row) => (
          <div key={row.step} className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all duration-150">
            <div className="flex items-center gap-4 min-w-0 pr-3">
              <div className={`w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center border ${
                row.done ? "bg-emerald-50 text-emerald-600 border-emerald-100" : "bg-slate-50 text-slate-400 border-slate-100"
              }`}>
                <Check size={15} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-800">{row.step}</span>
                  <Chip tone={row.done ? "emerald" : "slate"}>{row.done ? "done" : "open"}</Chip>
                </div>
                <p className="text-[11px] text-slate-500">{row.detail}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setTab(row.tab)}
              className="shrink-0 text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
            >
              Go <ArrowRight size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function tierLabel(tier: string, badge: number | null): string {
  if (tier === "founder_lifetime") return badge ? `Founder #${badge}` : "Founder Pass";
  if (tier === "pro") return "Ronic Pro";
  if (tier === "team") return "Team";
  return "Starter";
}

function licenseStatusLabel(status: string): string {
  if (status === "active") return "Ed25519 lease verified locally · works offline for 7 days";
  if (status === "local") return "registered on this machine · local free plan, works offline";
  if (status === "unsigned_dev") return "unsigned dev build — entitlements shown, not enforced";
  if (status === "expired") return "lease expired — sign in to refresh";
  if (status === "invalid") return "lease failed verification — sign in to refresh";
  return "no cloud lease yet";
}
