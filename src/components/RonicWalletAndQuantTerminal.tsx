import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ShieldCheck,
  ShieldAlert,
  Zap,
  KeyRound,
  Lock,
  X,
  CreditCard,
  ArrowLeftRight,
  Landmark,
  Globe,
  Search,
  Plus,
  Activity,
  Bot,
  ScrollText,
  Snowflake,
  Wallet,
  Copy,
  ExternalLink,
  QrCode,
  ArrowUpRight,
  ArrowDownLeft,
  Sliders,
  AlertTriangle,
  Trash2,
  Download,
  Eye,
  EyeOff,
} from "lucide-react";
import { useRonic } from "../store";
import { money, tone, when } from "../ui/bits";
import type { Balance, BotProfile, WalletTx, WatchedWallet } from "../types";

/* ── Multi-Chain Real Rails & Network Metadata ───────────────────── */

export type SupportedChain =
  | "base"
  | "ethereum"
  | "solana"
  | "arbitrum"
  | "polygon"
  | "hyperliquid"
  | "stripe"
  | "razorpay";

export interface ConnectedWallet {
  id: string;
  chain: SupportedChain;
  label: string;
  address: string;
  connectionType: "address_watch" | "private_key_vault" | "seed_phrase_vault" | "api_key";
  status: "active" | "frozen";
  balanceNative: string;
  balanceUsd: number;
  dailyLimitUsd: number;
  isDefault: boolean;
  addedAt: number;
  keyMask?: string;
  explorerUrl?: string;
}

export const CHAIN_META: Record<
  SupportedChain,
  {
    name: string;
    currency: string;
    icon: typeof Globe;
    iconClass: string;
    badgeClass: string;
    railKey: string;
    explorerBase: string;
    placeholder: string;
    defaultNote: string;
  }
> = {
  base: {
    name: "Base (USDC x402 & ETH)",
    currency: "USDC",
    icon: Globe,
    iconClass: "bg-blue-50 text-blue-600 border-blue-100",
    badgeClass: "bg-blue-50 text-blue-700 border-blue-200/80",
    railKey: "crypto_x402",
    explorerBase: "https://basescan.org/address/",
    placeholder: "0x...",
    defaultNote: "Agentic HTTP 402 micro-transactions & MCP service calls",
  },
  ethereum: {
    name: "Ethereum Mainnet",
    currency: "ETH",
    icon: Globe,
    iconClass: "bg-indigo-50 text-indigo-600 border-indigo-100",
    badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200/80",
    railKey: "crypto_x402",
    explorerBase: "https://etherscan.io/address/",
    placeholder: "0x...",
    defaultNote: "Institutional treasury & smart contract settlement",
  },
  solana: {
    name: "Solana Mainnet",
    currency: "SOL",
    icon: Zap,
    iconClass: "bg-purple-50 text-purple-600 border-purple-100",
    badgeClass: "bg-purple-50 text-purple-700 border-purple-200/80",
    railKey: "crypto_x402",
    explorerBase: "https://solscan.io/account/",
    placeholder: "Solana public address (base58)...",
    defaultNote: "High-frequency DEX, pump/raydium agent routing",
  },
  arbitrum: {
    name: "Arbitrum One L2",
    currency: "USDC",
    icon: Activity,
    iconClass: "bg-cyan-50 text-cyan-600 border-cyan-100",
    badgeClass: "bg-cyan-50 text-cyan-700 border-cyan-200/80",
    railKey: "crypto_x402",
    explorerBase: "https://arbiscan.io/address/",
    placeholder: "0x...",
    defaultNote: "Ultra low-cost Arbitrum L2 execution",
  },
  polygon: {
    name: "Polygon PoS",
    currency: "POL",
    icon: Globe,
    iconClass: "bg-violet-50 text-violet-600 border-violet-100",
    badgeClass: "bg-violet-50 text-violet-700 border-violet-200/80",
    railKey: "crypto_x402",
    explorerBase: "https://polygonscan.com/address/",
    placeholder: "0x...",
    defaultNote: "Polygon PoS stablecoin rails",
  },
  hyperliquid: {
    name: "Hyperliquid L1 & DEX Quant",
    currency: "USDC",
    icon: Activity,
    iconClass: "bg-emerald-50 text-emerald-600 border-emerald-100",
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
    railKey: "hyperliquid_ws",
    explorerBase: "https://app.hyperliquid.xyz/explorer/address/",
    placeholder: "0x...",
    defaultNote: "Sub-ms WebSocket orderbook & perp/spot router · 5 bps rebate",
  },
  stripe: {
    name: "Stripe Virtual Agent Cards",
    currency: "USD",
    icon: CreditCard,
    iconClass: "bg-fuchsia-50 text-fuchsia-600 border-fuchsia-100",
    badgeClass: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/80",
    railKey: "stripe_card",
    explorerBase: "https://dashboard.stripe.com/issuing",
    placeholder: "acct_... or Card Holder ID",
    defaultNote: "Single-use programmable virtual cards for browser tasks",
  },
  razorpay: {
    name: "RazorpayX INR UPI Rail (₹)",
    currency: "INR",
    icon: Landmark,
    iconClass: "bg-amber-50 text-amber-600 border-amber-100",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200/80",
    railKey: "razorpay_upi",
    explorerBase: "https://dashboard.razorpay.com/",
    placeholder: "merchant@upi or VPA ID",
    defaultNote: "Instant UPI payment links & vendor payouts (₹400 auto-cap)",
  },
};

const RAIL_META: Record<string, { label: string; badge: string; badgeClass: string; note: string; icon: typeof Globe; iconClass: string }> = {
  crypto_x402: {
    label: "x402 USDC Machine Rail",
    badge: "HTTP 402 READY",
    badgeClass: "bg-emerald-50 text-emerald-700 border border-emerald-200/80",
    note: "Base / Solana auto-micropayments for paid MCPs & APIs (≤ $5.00 cap).",
    icon: Globe,
    iconClass: "bg-blue-50 text-blue-600 border-blue-100",
  },
  razorpay_upi: {
    label: "RazorpayX INR UPI Rail (₹)",
    badge: "UPI INTENT",
    badgeClass: "bg-emerald-50 text-emerald-700 border border-emerald-200/80",
    note: "Instant UPI payment links & vendor payouts, gated by the ₹400 auto-sign cap.",
    icon: Landmark,
    iconClass: "bg-indigo-50 text-indigo-600 border-indigo-100",
  },
  stripe_card: {
    label: "Stripe Virtual Agent Cards",
    badge: "AGENT CARDS",
    badgeClass: "bg-slate-100 text-slate-700 border border-slate-200",
    note: "Single-use programmable virtual cards for @Dots browser checkout tasks.",
    icon: CreditCard,
    iconClass: "bg-purple-50 text-purple-600 border-purple-100",
  },
  hyperliquid_ws: {
    label: "Hyperliquid L1 & DEX Quant Rail",
    badge: "0.7ms RUST WS",
    badgeClass: "bg-emerald-50 text-emerald-700 border border-emerald-200/80",
    note: "Sub-ms WebSocket orderbook & perp/spot router · 5 bps (0.05%) Ronic builder rebate.",
    icon: Activity,
    iconClass: "bg-emerald-50 text-emerald-600 border-emerald-100",
  },
};

const ANALYSTS = [
  "Grok Pro + Rust WS Engine",
  "DeepSeek-V4 + Grok Sentiment",
  "Claude Code CLI (/hl-arb-execution)",
];

type SubTab = "wallets" | "queue" | "allowances" | "security" | "ledger" | "quant";

const SUB_TABS: { id: SubTab; label: string; icon: typeof Zap }[] = [
  { id: "wallets", label: "Connected Wallets & Rails", icon: Wallet },
  { id: "queue", label: "Fail-Closed Approval Queue", icon: ShieldCheck },
  { id: "allowances", label: "Assign Money & Bot Budgets", icon: Bot },
  { id: "security", label: "Money Security & Safeguards", icon: ShieldAlert },
  { id: "ledger", label: "Live Ledger & Transfers", icon: ScrollText },
  { id: "quant", label: "LLM + Rust Quant Terminal", icon: Zap },
];

const DEMO_WALLET_STORAGE_KEYS = [
  "ronic_connected_wallets_v2",
  "ronic_wallet_security_pin_v2",
  "ronic_wallet_whitelist_v2",
];

function purgeDemoWalletStorage() {
  try {
    for (const key of DEMO_WALLET_STORAGE_KEYS) localStorage.removeItem(key);
  } catch {
    // The desktop database is the store of record.
  }
}

purgeDemoWalletStorage();

function watchedWallets(rows: WatchedWallet[] | undefined): ConnectedWallet[] {
  const out: ConnectedWallet[] = [];
  for (const row of rows ?? []) {
    if (!(row.chain in CHAIN_META)) continue;
    const connectionType =
      row.connectionType === "private_key_vault" ||
      row.connectionType === "seed_phrase_vault" ||
      row.connectionType === "api_key" ||
      row.connectionType === "address_watch"
        ? row.connectionType
        : "address_watch";
    out.push({
      id: row.id,
      chain: row.chain as SupportedChain,
      label: row.label,
      address: row.address,
      connectionType,
      status: row.status === "frozen" ? "frozen" : "active",
      balanceNative: row.balanceNative,
      balanceUsd: row.balanceUsd,
      dailyLimitUsd: row.dailyLimitUsd,
      isDefault: row.isDefault,
      addedAt: row.addedAt,
      keyMask: row.keyMask,
      explorerUrl: row.explorerUrl,
    });
  }
  return out;
}

function verifiedPortfolioUsd(rows: WatchedWallet[] | undefined): number {
  return (rows ?? []).reduce((sum, wallet) => sum + ((wallet.verifiedAt ?? 0) > 0 ? wallet.balanceUsd : 0), 0);
}

/* ── UI Design-System Atoms ───────────────────────────────────────── */

function Chip({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "emerald" | "amber" | "rose" | "blue" | "purple" | "zinc";
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
    amber: "bg-amber-50 text-amber-700 border-amber-200/80",
    rose: "bg-rose-50 text-rose-700 border-rose-200/80",
    blue: "bg-blue-50 text-blue-700 border-blue-200/80",
    purple: "bg-purple-50 text-purple-700 border-purple-200/80",
    zinc: "bg-zinc-800 text-zinc-100 border-zinc-700",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${tones[tone]}`}>
      {children}
    </span>
  );
}

function decisionChip(decision: string): "emerald" | "amber" | "rose" {
  const t = tone(decision);
  if (t === "bad") return "rose";
  if (t === "warn") return "amber";
  return "emerald";
}

/* ── Main Component ──────────────────────────────────────────────── */

export default function RonicWalletAndQuantTerminal() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  const [subTab, setSubTab] = useState<SubTab>("wallets");
  const wallets = useMemo(() => watchedWallets(snap.connectedWallets), [snap.connectedWallets]);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [selectedWalletForModal, setSelectedWalletForModal] = useState<ConnectedWallet | null>(null);
  const [selectedBotForBudget, setSelectedBotForBudget] = useState<BotProfile | null>(null);

  const policy = snap.policy;
  const pending = snap.transactions.filter((tx) => tx.policyDecision === "pending_approval");
  const lastLatency = snap.quantOrders[0]?.wsLatencyMs;
  const totalRebate = useMemo(() => snap.quantOrders.reduce((sum, ord) => sum + ord.rebateUsd, 0), [snap.quantOrders]);
  const totalPortfolioUsd = useMemo(() => verifiedPortfolioUsd(snap.connectedWallets), [snap.connectedWallets]);

  const askPin = async (label: string) => {
    if (!snap.walletPinSet) {
      window.alert("Set a wallet PIN on the security tab first. There is no default PIN.");
      setSubTab("security");
      return false;
    }
    const pin = window.prompt(label);
    if (pin === null) return false;
    const accepted = await run("check_wallet_pin", { pin });
    return accepted !== null;
  };

  const handleWalletRemoved = (walletId: string) => {
    void run("disconnect_watched_wallet", { id: walletId });
  };

  const handleWalletToggleFreeze = (walletId: string) => {
    const wallet = wallets.find((item) => item.id === walletId);
    if (!wallet) return;
    void run("update_watched_wallet", {
      id: walletId,
      status: wallet.status === "active" ? "frozen" : "active",
      makeDefault: false,
    });
  };

  const handleSetDefaultWallet = (walletId: string) => {
    void run("update_watched_wallet", { id: walletId, status: "", makeDefault: true });
  };

  const handleRefreshWallet = (walletId: string) => {
    void run("refresh_wallet_balance", { id: walletId });
  };

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">

        {/* ─── EMERGENCY KILLSWITCH BANNER ─── */}
        {policy.killswitchEngaged ? (
          <div className="bg-rose-500 text-white px-6 py-2.5 flex items-center justify-between text-xs font-semibold shadow-inner">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} />
              <span>EMERGENCY FREEZE ENGAGED: All outbound bot transactions and key signers are physically blocked at the Rust kernel gate.</span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void askPin("Enter your wallet PIN to disarm the freeze. There is no default PIN.").then((ok) => {
                  if (!ok) return;
                  void run("set_policy", {
                    maxPerTxUsd: policy.maxPerTxUsd,
                    dailyCapUsd: policy.dailyCapUsd,
                    requireHumanApprovalAboveUsd: policy.requireHumanApprovalAboveUsd,
                    maxSlippageBps: policy.maxSlippageBps,
                    killswitchEngaged: false,
                  });
                });
              }}
              className="px-3 py-1 bg-white text-rose-700 hover:bg-rose-50 rounded-full font-bold cursor-pointer text-[11px]"
            >
              Disarm Killswitch
            </button>
          </div>
        ) : null}

        {/* ─── HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Agentic Wallet &amp; Quant Terminal</h1>
                <Chip tone="slate">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  BALANCE READS · NO CHAIN SIGNATURE
                </Chip>
                <Chip tone="slate">
                  <Lock size={10} /> LOCAL AES-256 VAULT
                </Chip>
              </div>
              <p className="text-xs text-slate-500 mt-1.5 max-w-3xl leading-relaxed">
                Balances are read from the chain or your provider key. Verified total: <strong className="text-slate-800 font-mono">{money(totalPortfolioUsd)}</strong>. Send records a workspace-ledger spend through the policy gate. It does not broadcast a chain transaction or create a card charge, and a chain card stays a read. Bot spends above{" "}
                {money(policy.requireHumanApprovalAboveUsd)} wait in the approval queue.
                {lastLatency != null ? ` · last route ${lastLatency.toFixed(1)}ms` : ""}
              </p>
            </div>

            {/* Quick Actions */}
            <div className="shrink-0 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setShowConnectModal(true)}
                className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
              >
                <Plus size={13} /> Connect Real Wallet
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedWalletForModal(wallets[0] || null);
                  setShowDepositModal(true);
                }}
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
              >
                <ArrowDownLeft size={13} /> Deposit
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedWalletForModal(wallets[0] || null);
                  setShowTransferModal(true);
                }}
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
              >
                <ArrowUpRight size={13} /> Send / Transfer
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void askPin(`Enter your wallet PIN to ${policy.killswitchEngaged ? "disarm" : "engage"} the freeze. There is no default PIN.`).then((ok) => {
                    if (!ok) return;
                    void run("set_policy", {
                      maxPerTxUsd: policy.maxPerTxUsd,
                      dailyCapUsd: policy.dailyCapUsd,
                      requireHumanApprovalAboveUsd: policy.requireHumanApprovalAboveUsd,
                      maxSlippageBps: policy.maxSlippageBps,
                      killswitchEngaged: !policy.killswitchEngaged,
                    });
                  });
                }}
                className={`text-xs font-bold px-3.5 py-2 rounded-full transition-all cursor-pointer active:scale-95 flex items-center gap-1.5 ${
                  policy.killswitchEngaged
                    ? "bg-rose-600 hover:bg-rose-700 text-white shadow-xs"
                    : "bg-white text-rose-600 border border-rose-200 hover:bg-rose-50"
                }`}
              >
                <AlertTriangle size={13} /> {policy.killswitchEngaged ? "Killswitch Active" : "Emergency Freeze"}
              </button>
            </div>
          </div>

          {/* ─── SUB-TABS ─── */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1">
            {SUB_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={subTab === id}
                onClick={() => setSubTab(id)}
                className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                  subTab === id
                    ? "bg-zinc-800 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                }`}
              >
                <Icon size={12} />
                {label}
                {id === "queue" && pending.length > 0 ? (
                  <span className="w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center ml-0.5">
                    {pending.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* ─── BODY ─── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-7">
          {subTab === "wallets" ? (
            <ConnectedWalletsTab
              wallets={wallets}
              balances={snap.balances}
              spentToday={snap.spentTodayUsd}
              dailyCap={policy.dailyCapUsd}
              totalRebate={totalRebate}
              onOpenConnect={() => setShowConnectModal(true)}
              onOpenDeposit={(w) => {
                setSelectedWalletForModal(w);
                setShowDepositModal(true);
              }}
              onOpenTransfer={(w) => {
                setSelectedWalletForModal(w);
                setShowTransferModal(true);
              }}
              onToggleFreeze={handleWalletToggleFreeze}
              onSetDefault={handleSetDefaultWallet}
              onRemove={handleWalletRemoved}
              onRefresh={handleRefreshWallet}
            />
          ) : null}

          {subTab === "queue" ? (
            <QueueTab
              pending={pending}
              busy={busy}
              onReview={(txId, approve) => {
                if (!approve) {
                  void run("review_tx", { txId, approve });
                  return;
                }
                void askPin("Enter your wallet PIN to approve this spend. There is no default PIN.").then((ok) => {
                  if (!ok) return;
                  void run("review_tx", { txId, approve });
                });
              }}
              approvalAbove={policy.requireHumanApprovalAboveUsd}
              spentToday={snap.spentTodayUsd}
              dailyCap={policy.dailyCapUsd}
              totalRebate={totalRebate}
              balances={snap.balances}
            />
          ) : null}

          {subTab === "allowances" ? (
            <BotAllowanceManagementTab
              busy={busy}
              profiles={snap.profiles}
              onAdjustBudget={(bot) => setSelectedBotForBudget(bot)}
            />
          ) : null}

          {subTab === "security" ? (
            <SecuritySafeguardsTab
              policy={policy}
              busy={busy}
              onUpdatePolicy={(patch) => {
                void run("set_policy", {
                  maxPerTxUsd: patch.maxPerTxUsd ?? policy.maxPerTxUsd,
                  dailyCapUsd: patch.dailyCapUsd ?? policy.dailyCapUsd,
                  requireHumanApprovalAboveUsd: patch.requireHumanApprovalAboveUsd ?? policy.requireHumanApprovalAboveUsd,
                  maxSlippageBps: Math.round(patch.maxSlippageBps ?? policy.maxSlippageBps),
                  killswitchEngaged: patch.killswitchEngaged ?? policy.killswitchEngaged,
                });
              }}
            />
          ) : null}

          {subTab === "ledger" ? (
            <LiveLedgerTab
              onOpenDeposit={() => setShowDepositModal(true)}
              onOpenTransfer={() => setShowTransferModal(true)}
            />
          ) : null}

          {subTab === "quant" ? <QuantTerminal busy={busy} /> : null}
        </div>

        {/* ─── FOOTER STATUS BAR ─── */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2 truncate pr-4">
            <span className="w-2 h-2 rounded-full shrink-0 bg-emerald-500" />
            <span className="truncate">
              {wallets.length} connected wallet{wallets.length === 1 ? "" : "s"} · balances refresh from the chain · bot budgets stay inside the verified total
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span className="font-mono">{snap.transactions.length} ledger rows</span>
            <span>·</span>
            <span className="font-mono">{pending.length} awaiting human review</span>
          </div>
        </div>
      </div>

      {/* ─── MODALS ─── */}
      {showConnectModal ? (
        <ConnectWalletModal
          onClose={() => setShowConnectModal(false)}
        />
      ) : null}

      {showDepositModal ? (
        <DepositModal
          wallets={wallets}
          initialWallet={selectedWalletForModal}
          onClose={() => setShowDepositModal(false)}
        />
      ) : null}

      {showTransferModal ? (
        <TransferModal
          wallets={wallets}
          balances={snap.balances}
          initialWallet={selectedWalletForModal}
          approvalAbove={policy.requireHumanApprovalAboveUsd}
          askPin={askPin}
          onClose={() => setShowTransferModal(false)}
        />
      ) : null}

      {selectedBotForBudget ? (
        <AdjustBotBudgetModal
          bot={selectedBotForBudget}
          onClose={() => setSelectedBotForBudget(null)}
        />
      ) : null}
    </div>
  );
}

/* ── Tab 1: Connected Wallets & Real Rails ────────────────────────── */

function ConnectedWalletsTab({
  wallets,
  balances,
  spentToday,
  dailyCap,
  totalRebate,
  onOpenConnect,
  onOpenDeposit,
  onOpenTransfer,
  onToggleFreeze,
  onSetDefault,
  onRemove,
  onRefresh,
}: {
  wallets: ConnectedWallet[];
  balances: Balance[];
  spentToday: number;
  dailyCap: number;
  totalRebate: number;
  onOpenConnect: () => void;
  onOpenDeposit: (w: ConnectedWallet) => void;
  onOpenTransfer: (w: ConnectedWallet) => void;
  onToggleFreeze: (walletId: string) => void;
  onSetDefault: (walletId: string) => void;
  onRemove: (walletId: string) => void;
  onRefresh: (walletId: string) => void;
}) {
  const byRailBalances = new Map(balances.map((b) => [b.rail, b]));
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Top Overview Cards */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Payment Rails &amp; Balances</h2>
          <span className="text-[11px] font-mono text-slate-400">
            spent today {money(spentToday)} / {money(dailyCap)} · rebate {money(totalRebate)}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          {Object.entries(RAIL_META).map(([rail, meta]) => (
            <RailCard key={rail} rail={rail} balance={byRailBalances.get(rail)} meta={meta} />
          ))}
          <RailSpendCard spentToday={spentToday} dailyCap={dailyCap} totalRebate={totalRebate} />
        </div>
      </div>

      {/* Connected Real Wallets Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-2 flex-wrap gap-2">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Connected Real Wallets ({wallets.length})</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              A wallet appears after a live balance read. A zero balance is a real zero. Nothing is filled in from a demo.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenConnect}
            className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
          >
            <Plus size={12} /> Add / Connect Wallet
          </button>
        </div>

        {wallets.length === 0 ? (
          <div className="py-14 text-center space-y-2 border border-dashed border-slate-200 rounded-3xl bg-slate-50/60">
            <Wallet size={20} className="mx-auto text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">No wallet is connected</p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Connect a public address. The balance is read from the chain or your provider key. The sandbox faucet is off, and a typed amount is not credited.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {wallets.map((wallet) => {
            const meta = CHAIN_META[wallet.chain] || CHAIN_META.base;
            const Icon = meta.icon;
            const isFrozen = wallet.status === "frozen";

            return (
              <div
                key={wallet.id}
                className={`bg-white border rounded-2xl p-4 shadow-xs hover:shadow-md transition-all flex flex-col justify-between space-y-3 ${
                  isFrozen ? "border-rose-200 bg-rose-50/20" : wallet.isDefault ? "border-slate-400 ring-1 ring-slate-300" : "border-slate-200/80"
                }`}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${meta.iconClass}`}>
                      <Icon size={16} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className="text-xs font-bold text-slate-800 truncate">{wallet.label}</h3>
                        {wallet.isDefault ? <Chip tone="zinc">PRIMARY</Chip> : null}
                        {isFrozen ? <Chip tone="rose">FROZEN</Chip> : <Chip tone="emerald">ACTIVE</Chip>}
                      </div>
                      <span className="text-[10.5px] text-slate-400 font-medium">{meta.name}</span>
                    </div>
                  </div>

                  <span className={`text-[9.5px] font-bold px-2 py-0.5 rounded-full ${meta.badgeClass}`}>
                    {wallet.connectionType.toUpperCase().replace("_", " ")}
                  </span>
                </div>

                {/* Address bar */}
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-slate-700 truncate">{wallet.address}</span>
                  <div className="shrink-0 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(wallet.address, wallet.id)}
                      title="Copy Address"
                      className="p-1 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-200/60 transition-colors cursor-pointer"
                    >
                      {copiedId === wallet.id ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                    </button>
                    {wallet.explorerUrl ? (
                      <a
                        href={wallet.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="View in Explorer"
                        className="p-1 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-200/60 transition-colors"
                      >
                        <ExternalLink size={12} />
                      </a>
                    ) : null}
                  </div>
                </div>

                {/* Balances & limits */}
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-100 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">Balance</span>
                    <span className="font-bold text-slate-800 font-mono text-sm">{wallet.balanceNative}</span>
                    <span className="text-[10px] text-slate-400 block font-mono">≈ {money(wallet.balanceUsd)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase block">Daily Spend Cap</span>
                    <span className="font-bold text-slate-800 font-mono text-sm">{money(wallet.dailyLimitUsd)}</span>
                    <span className="text-[10px] text-slate-400 block">per UTC day</span>
                  </div>
                </div>

                {/* Card Actions */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100/80 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onRefresh(wallet.id)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
                    >
                      <Activity size={11} /> Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenDeposit(wallet)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
                    >
                      <ArrowDownLeft size={11} /> Deposit
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenTransfer(wallet)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
                    >
                      <ArrowUpRight size={11} /> Send
                    </button>
                    {!wallet.isDefault ? (
                      <button
                        type="button"
                        onClick={() => onSetDefault(wallet.id)}
                        className="text-[11px] font-medium text-slate-500 hover:text-slate-800 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        Set Primary
                      </button>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onToggleFreeze(wallet.id)}
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition-all cursor-pointer active:scale-95 flex items-center gap-1 ${
                        isFrozen
                          ? "bg-rose-50 text-rose-600 border-rose-200 hover:bg-rose-100"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      {isFrozen ? <Snowflake size={11} /> : <ShieldCheck size={11} />}
                      {isFrozen ? "Unfreeze" : "Freeze"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Remove wallet "${wallet.label}" from connected rails?`)) {
                          onRemove(wallet.id);
                        }
                      }}
                      title="Disconnect wallet"
                      className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors cursor-pointer"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Tab 2: Bot Allowance & Spending Management ───────────────────── */

function BotAllowanceManagementTab({
  busy,
  profiles,
  onAdjustBudget,
}: {
  busy: boolean;
  profiles: BotProfile[];
  onAdjustBudget: (bot: BotProfile) => void;
}) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-2 flex-wrap gap-2">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Bot Real Money Spending Budgets &amp; Breakers</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Assign real money spending limits ($/day) to your autonomous bots. The compiled Rust policy gate verifies limits before signing any transaction.
          </p>
        </div>
        <span className="text-[11px] font-mono text-slate-400">{profiles.length} autonomous bots</span>
      </div>

      <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
        {profiles.length === 0 ? (
          <div className="py-14 text-center space-y-2">
            <Bot size={20} className="mx-auto text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">No bot profiles found</p>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">Create a bot profile in Botfleet to assign real money limits.</p>
          </div>
        ) : null}

        {profiles.map((bot) => {
          const allowance = snap.botAllowances.find((a) => a.botId === bot.id);
          const limit = bot.dailyWalletLimitUsd ?? 0;
          const spent = allowance?.spentTodayUsd || 0.0;
          const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
          const isFrozen = allowance?.frozen || false;

          return (
            <div key={bot.id} className="flex items-center justify-between gap-4 px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all group">
              <div className="flex items-center gap-3.5 min-w-0 flex-1">
                <div
                  className={`w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center font-bold text-xs border ${
                    isFrozen
                      ? "bg-rose-50 border-rose-200 text-rose-600"
                      : "bg-zinc-800 border-zinc-700 text-white"
                  }`}
                >
                  {isFrozen ? <Snowflake size={16} /> : bot.handle.slice(0, 2).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-900 font-mono">@{bot.handle}</span>
                    <span className="text-xs text-slate-500 truncate">— {bot.displayName || bot.role || "Autonomous Agent"}</span>
                    {isFrozen ? <Chip tone="rose">FROZEN</Chip> : <Chip tone="emerald">ACTIVE RAILS</Chip>}
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-slate-400 font-mono mt-0.5 flex-wrap">
                    <span>Engine: {bot.engineKind || "Auto"}</span>
                    <span>·</span>
                    <span>Daily Budget: <strong className="text-slate-700 font-mono">{money(limit)}</strong></span>
                    <span>·</span>
                    <span>Spent Today: <strong className="text-slate-700 font-mono">{money(spent)}</strong> ({pct.toFixed(0)}%)</span>
                  </div>

                  {/* Progress bar */}
                  <div className="mt-1.5 h-1.5 rounded-full bg-slate-200/70 overflow-hidden max-w-md" aria-hidden="true">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isFrozen ? "bg-rose-400" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Bot budget actions */}
              <div className="shrink-0 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onAdjustBudget(bot)}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
                >
                  <Sliders size={11} /> Adjust Budget
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run("bot_circuit_toggle", { botId: bot.id })}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-full transition-all cursor-pointer active:scale-95 flex items-center gap-1.5 ${
                    isFrozen
                      ? "bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100"
                      : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {isFrozen ? <Snowflake size={11} /> : <ShieldCheck size={11} />}
                  {isFrozen ? "Unfreeze" : "Freeze Spend"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Tab 3: Security & Safeguards ────────────────────────────────── */

function SecuritySafeguardsTab({
  policy,
  busy,
  onUpdatePolicy,
}: {
  policy: {
    maxPerTxUsd: number;
    dailyCapUsd: number;
    requireHumanApprovalAboveUsd: number;
    maxSlippageBps: number;
    killswitchEngaged: boolean;
  };
  busy: boolean;
  onUpdatePolicy: (patch: Partial<typeof policy>) => void;
}) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinNote, setPinNote] = useState("");

  const inputCls =
    "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

  const handleSavePin = async () => {
    if (newPin.trim().length < 4) {
      setPinNote("Use a 4 to 8 digit PIN. There is no default PIN.");
      return;
    }
    const saved = await run("set_wallet_pin", { pin: newPin.trim(), current: currentPin.trim() });
    if (!saved) return;
    setCurrentPin("");
    setNewPin("");
    setPinNote("Wallet PIN saved. It is not shown again.");
  };

  const confirmFreezePin = async () => {
    if (!snap.walletPinSet) {
      setPinNote("Set a wallet PIN first. There is no default PIN.");
      return;
    }
    const entered = window.prompt(`Enter your wallet PIN to ${policy.killswitchEngaged ? "disarm" : "engage"} the freeze. There is no default PIN.`);
    if (entered === null) return;
    const accepted = await run("check_wallet_pin", { pin: entered });
    if (!accepted) return;
    onUpdatePolicy({ killswitchEngaged: !policy.killswitchEngaged });
  };

  return (
    <div className="space-y-6">
      {/* Global Emergency Nuclear Killswitch */}
      <div className="bg-rose-50/60 border border-rose-200/90 rounded-3xl p-5 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldAlert size={18} className="text-rose-600" />
              <h3 className="text-sm font-bold text-rose-900">Nuclear Emergency Killswitch</h3>
              <Chip tone={policy.killswitchEngaged ? "rose" : "slate"}>
                {policy.killswitchEngaged ? "LOCKED & FROZEN" : "SYSTEM ARMED"}
              </Chip>
            </div>
            <p className="text-xs text-rose-700/90 max-w-2xl leading-relaxed">
              When engaged, outbound bot spends are rejected at the policy gate. Turning this on does not move money, and it does not sign a chain transaction.
            </p>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void confirmFreezePin();
            }}
            className={`px-5 py-2.5 text-xs font-bold rounded-xl transition-all cursor-pointer active:scale-95 flex items-center gap-2 shadow-xs ${
              policy.killswitchEngaged
                ? "bg-rose-600 hover:bg-rose-700 text-white shadow-rose-200"
                : "bg-white text-rose-700 border border-rose-300 hover:bg-rose-100"
            }`}
          >
            <AlertTriangle size={14} />
            {policy.killswitchEngaged ? "Disarm Nuclear Killswitch" : "ENGAGE NUCLEAR KILLSWITCH"}
          </button>
        </div>
      </div>

      {/* Grid of Security Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Master Security PIN */}
        <div className="bg-slate-50/50 rounded-3xl p-5 border border-slate-100/80 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound size={16} className="text-slate-700" />
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Master Security PIN</h3>
            </div>
            <span className="text-[10px] font-mono text-slate-400">{snap.walletPinSet ? "PIN set" : "No PIN yet"}</span>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Required before approving a queued spend or changing the freeze. The PIN is hashed in the local database and is never shown. There is no default PIN.
          </p>

          <div className="space-y-3 pt-1">
            {snap.walletPinSet ? (
              <input
                type="password"
                maxLength={8}
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
                placeholder="Current PIN"
                className={inputCls}
              />
            ) : null}
            <div className="flex items-center gap-2">
              <input
                type="password"
                maxLength={8}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                placeholder="New 4-8 digit PIN"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => void handleSavePin()}
                disabled={newPin.length < 4 || busy}
                className="shrink-0 text-xs font-semibold px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Save PIN
              </button>
            </div>
            {pinNote ? <p className="text-[11px] text-slate-600 font-semibold">{pinNote}</p> : null}
          </div>
        </div>

        {/* Policy Gate Limits */}
        <div className="bg-slate-50/50 rounded-3xl p-5 border border-slate-100/80 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-slate-700" />
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Policy Gate Limits</h3>
            </div>
            <Chip tone="emerald">Rust Kernel Enforced</Chip>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Human Approval Ceiling (USD)"
              value={policy.requireHumanApprovalAboveUsd}
              onCommit={(requireHumanApprovalAboveUsd) => onUpdatePolicy({ requireHumanApprovalAboveUsd })}
              inputCls={inputCls}
            />
            <NumberField
              label="Global Daily Cap (USD)"
              value={policy.dailyCapUsd}
              onCommit={(dailyCapUsd) => onUpdatePolicy({ dailyCapUsd })}
              inputCls={inputCls}
            />
            <NumberField
              label="Max Per Transaction (USD)"
              value={policy.maxPerTxUsd}
              onCommit={(maxPerTxUsd) => onUpdatePolicy({ maxPerTxUsd })}
              inputCls={inputCls}
            />
            <NumberField
              label="Max Slippage (bps)"
              value={policy.maxSlippageBps}
              onCommit={(maxSlippageBps) => onUpdatePolicy({ maxSlippageBps })}
              inputCls={inputCls}
            />
          </div>
          <p className="text-[10.5px] text-slate-400 leading-relaxed">
            Any transaction above <strong>{money(policy.requireHumanApprovalAboveUsd)}</strong> is held in the Human Approval Queue. Over daily cap is hard rejected.
          </p>
        </div>
      </div>

      <div className="bg-slate-50/50 rounded-3xl p-5 border border-slate-100/80 space-y-3">
        <div>
          <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Spend gate</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            No demo addresses are pre-approved. A bot can spend only inside its daily budget, the per-transaction cap, and the verified wallet total.
          </p>
        </div>
        {snap.policy.whitelisted.length > 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {snap.policy.whitelisted.map((item) => (
              <div key={item} className="px-4 py-2.5 text-xs font-mono text-slate-700 truncate">{item}</div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">The policy list is empty.</p>
        )}
      </div>
    </div>
  );
}

/* ── Tab 4: Live Ledger & Direct Transfers ────────────────────────── */

function LiveLedgerTab({
  onOpenDeposit,
  onOpenTransfer,
}: {
  onOpenDeposit: () => void;
  onOpenTransfer: () => void;
}) {
  const snap = useRonic((s) => s.snap)!;
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    let rows = snap.transactions;
    if (statusFilter !== "all") {
      rows = rows.filter((tx) => tx.policyDecision.toLowerCase().includes(statusFilter));
    }
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (tx) =>
        tx.botHandle.toLowerCase().includes(q) ||
        tx.purpose.toLowerCase().includes(q) ||
        tx.nativeAmount.toLowerCase().includes(q) ||
        tx.counterparty.toLowerCase().includes(q) ||
        tx.policyDecision.toLowerCase().includes(q)
    );
  }, [snap.transactions, query, statusFilter]);

  const handleExportCsv = () => {
    const headers = ["Timestamp", "ID", "Actor", "Bot", "Rail", "Native Amount", "USD Amount", "Counterparty", "Purpose", "Policy Decision", "Ref Hash"];
    const rows = snap.transactions.map((t) => [
      new Date(t.createdAt).toISOString(),
      t.id,
      t.actor,
      t.botHandle,
      t.rail,
      `"${t.nativeAmount}"`,
      t.amountUsd,
      `"${t.counterparty}"`,
      `"${t.purpose.replace(/"/g, '""')}"`,
      t.policyDecision,
      t.txHashOrRef || "",
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `ronic_wallet_audit_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-2 gap-3 flex-wrap">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Live Settlement Ledger</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Cryptographically signed ledger entries with verified local state transitions.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onOpenDeposit}
            className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
          >
            <ArrowDownLeft size={12} /> Deposit Funds
          </button>
          <button
            type="button"
            onClick={onOpenTransfer}
            className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
          >
            <ArrowUpRight size={12} /> Send / Transfer
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="text-xs font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
          >
            <Download size={12} /> Export Statement CSV
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap px-2">
        <div className="flex items-center gap-2">
          {["all", "auto_signed", "pending", "approved", "rejected"].map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              className={`text-[11px] font-semibold px-3 py-1 rounded-full capitalize transition-all cursor-pointer ${
                statusFilter === filter
                  ? "bg-zinc-800 text-white shadow-xs"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80"
              }`}
            >
              {filter.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions, handles, purposes…"
            className="pl-8 pr-3 py-1.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-full text-slate-800 placeholder:text-slate-400 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all w-64"
          />
        </div>
      </div>

      {/* Ledger Feed */}
      <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
        {filtered.length === 0 ? (
          <div className="py-14 text-center space-y-1.5">
            <ScrollText size={20} className="mx-auto text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">No matching transactions</p>
            <p className="text-xs text-slate-400">All agent transactions and manual transfers land in this ledger.</p>
          </div>
        ) : null}

        {filtered.map((tx) => (
          <div key={tx.id} className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all duration-150">
            <div className="flex items-center gap-3.5 min-w-0 pr-3">
              <div
                className={`w-9 h-9 rounded-xl shrink-0 shadow-xs flex items-center justify-center border ${
                  tx.effect === "credit"
                    ? "bg-emerald-50 border-emerald-100 text-emerald-600"
                    : tx.policyDecision.includes("rejected")
                    ? "bg-rose-50 border-rose-100 text-rose-600"
                    : "bg-blue-50 border-blue-100 text-blue-600"
                }`}
              >
                {tx.effect === "credit" ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-slate-800 font-mono">
                    {tx.botHandle ? `@${tx.botHandle}` : tx.actor === "user" ? "You (Manual Transfer)" : "Operator"}
                  </span>
                  <Chip tone="slate">{railLabel(tx.rail)}</Chip>
                  <span className="text-xs font-bold text-slate-900 font-mono">{tx.nativeAmount}</span>
                  {tx.amountUsd ? <span className="text-[10px] text-slate-400 font-mono">({money(tx.amountUsd)})</span> : null}
                </div>

                <p className="text-[11px] text-slate-500 truncate max-w-md">
                  Target: <span className="font-mono">{tx.counterparty}</span> — {tx.purpose}
                </p>
                {tx.txHashOrRef ? (
                  <p className="text-[10px] text-slate-400 font-mono truncate">
                    Ref: {tx.txHashOrRef}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-3">
              <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">{when(tx.createdAt)}</span>
              <Chip tone={decisionChip(tx.policyDecision)}>{tx.policyDecision}</Chip>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Queue Tab ───────────────────────────────────────────────────── */

function QueueTab({
  pending,
  busy,
  onReview,
  approvalAbove,
  spentToday,
  dailyCap,
  totalRebate,
  balances,
}: {
  pending: WalletTx[];
  busy: boolean;
  onReview: (txId: string, approve: boolean) => void;
  approvalAbove: number;
  spentToday: number;
  dailyCap: number;
  totalRebate: number;
  balances: Balance[];
}) {
  const byRailBalances = new Map(balances.map((b) => [b.rail, b]));
  return (
    <>
      {/* Rail cards */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Payment rails</h2>
          <span className="text-[11px] font-mono text-slate-400">
            spent today {money(spentToday)} / {money(dailyCap)} · rebate {money(totalRebate)}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          {Object.entries(RAIL_META).map(([rail, meta]) => (
            <RailCard key={rail} rail={rail} balance={byRailBalances.get(rail)} meta={meta} />
          ))}
          <RailSpendCard spentToday={spentToday} dailyCap={dailyCap} totalRebate={totalRebate} />
        </div>
      </div>

      {/* Fail-closed queue */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Fail-closed human approval queue</h2>
          <Chip tone={pending.length ? "amber" : "emerald"}>{pending.length} awaiting sign-off</Chip>
        </div>
        <p className="text-[11px] text-slate-500 px-2">
          Any bot transaction above {money(approvalAbove)} (or the ₹400 UPI cap) is paused here before the Rust signer emits a signature. Rejection requires Master Security PIN confirmation.
        </p>
        <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
          {pending.length === 0 ? (
            <div className="py-14 text-center space-y-2">
              <ShieldCheck size={20} className="mx-auto text-emerald-500" />
              <p className="text-sm font-semibold text-slate-700">Nothing is waiting</p>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">Auto-signed movements land directly in the ledger.</p>
            </div>
          ) : null}
          {pending.map((tx) => (
            <div key={tx.id} className="flex items-center justify-between px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all duration-150 group">
              <div className="flex items-center gap-4 min-w-0 pr-3">
                <div className="w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center bg-amber-50 border border-amber-100 text-amber-600">
                  <KeyRound size={16} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-800 font-mono">{tx.botHandle || "you"}</span>
                    <Chip tone="slate">{railLabel(tx.rail)}</Chip>
                    <span className="text-sm font-bold text-slate-900 font-mono">{tx.nativeAmount}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 truncate max-w-md">
                    Target <span className="font-mono">{tx.counterparty}</span> — {tx.purpose}
                  </p>
                  <p className="text-[10px] text-slate-400 font-mono truncate max-w-md">
                    Policy gate: {tx.amountUsd > approvalAbove ? `exceeds ${money(approvalAbove)} auto-sign cap` : "held for review by policy"} · {when(tx.createdAt)}
                  </p>
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onReview(tx.id, true)}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all duration-150 cursor-pointer bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Check size={11} /> Approve &amp; Sign (&lt;1ms)
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onReview(tx.id, false)}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all duration-150 cursor-pointer bg-white text-rose-600 border border-rose-200 hover:bg-rose-50 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <X size={11} /> Reject &amp; Halt Bot
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── Tab 5: Quant Terminal ────────────────────────────────────────── */

function QuantTerminal({ busy }: { busy: boolean }) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const [pair, setPair] = useState("SOL-USD-PERP");
  const [side, setSide] = useState("LONG");
  const [size, setSize] = useState("200");
  const [analyst, setAnalyst] = useState(ANALYSTS[0]);
  const [thesis, setThesis] = useState("Orderbook imbalance with positive funding divergence");
  const orders = snap.quantOrders;
  const avgLatency = orders.length ? orders.reduce((sum, ord) => sum + ord.wsLatencyMs, 0) / orders.length : 0;
  const signed = orders.filter((ord) => ord.status === "FILLED" || ord.status === "SIMULATED").length;
  const held = orders.filter((ord) => ord.status === "WORKING").length;

  const inputCls =
    "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <article className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800">Layer 1 · LLM Signal &amp; Regime Analyst</h3>
            <Chip tone="emerald">reasoning</Chip>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Linked <strong>Grok Pro</strong>, <strong>DeepSeek</strong>, and <strong>Claude</strong> score market structure, funding rates, and news sentiment. Every thesis is stored with the order for audit.
          </p>
        </article>
        <article className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800">Layer 2 · Sub-Millisecond Rust WebSocket Router</h3>
            <Chip tone="emerald">execution</Chip>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Deterministic limit / TWAP / arb execution over <span className="font-mono">wss://api.hyperliquid.xyz/ws</span> with hard stop-loss &amp; max-drawdown circuit breakers enforced in compiled Rust, plus a 5 bps Ronic builder rebate on every route.
          </p>
        </article>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Dispatch a quant signal</h2>
          <span className="text-[11px] font-mono text-slate-400">
            avg route {avgLatency ? `${avgLatency.toFixed(1)}ms` : "—"} · {signed} signed · {held} held
          </span>
        </div>
        <div className="bg-slate-50/50 rounded-3xl p-4 border border-slate-100/80 space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Pair</span>
              <input className={inputCls} value={pair} onChange={(e) => setPair(e.target.value)} placeholder="SOL-USD-PERP" />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Side</span>
              <select className={inputCls} value={side} onChange={(e) => setSide(e.target.value)}>
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
                <option value="ARB_SPREAD">ARB_SPREAD</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Size USD</span>
              <input className={inputCls} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">LLM analyst</span>
              <select className={inputCls} value={analyst} onChange={(e) => setAnalyst(e.target.value)}>
                {ANALYSTS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="space-y-1 block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Thesis (stored with the order)</span>
            <input className={inputCls} value={thesis} onChange={(e) => setThesis(e.target.value)} />
          </label>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-slate-400 max-w-xl leading-relaxed">
              Orders above your approval cap are routed to the fail-closed queue instead of being signed. Live-signer routes report FILLED.
            </p>
            <button
              type="button"
              disabled={busy || !(Number(size) > 0) || pair.trim().length === 0}
              onClick={() => void run("quant_dispatch", { pair: pair.trim(), side, sizeUsd: Number(size), analyst, thesis })}
              className="text-xs font-bold px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
            >
              <Zap size={12} /> Trigger Quant Signal &amp; WS Order
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Order routing feed</h2>
          <span className="text-[11px] font-mono text-slate-400">builder rebate telemetry</span>
        </div>
        <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
          {orders.length === 0 ? (
            <div className="py-14 text-center space-y-2">
              <Activity size={20} className="mx-auto text-slate-300" />
              <p className="text-sm font-semibold text-slate-700">No quant orders yet</p>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">Dispatch a signal above to open the routing feed.</p>
            </div>
          ) : null}
          {orders.map((ord) => (
            <div key={ord.id} className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl hover:bg-slate-100/80 transition-all duration-150">
              <div className="flex items-center gap-4 min-w-0 pr-3">
                <div className="w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center bg-emerald-50 border border-emerald-100 text-emerald-600">
                  <Zap size={15} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-900 font-mono">{ord.pair}</span>
                    <Chip tone={ord.side === "SHORT" ? "rose" : "blue"}>{ord.side}</Chip>
                    <span className="text-xs font-semibold text-slate-600 font-mono">{money(ord.sizeUsd)}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 truncate max-w-lg">{ord.analyst} · {ord.thesis}</p>
                  <p className="text-[10px] text-slate-400 font-mono">
                    {when(ord.createdAt)} · {ord.botHandle || "you"} · route {ord.wsLatencyMs.toFixed(2)}ms · rebate {money(ord.rebateUsd)}
                  </p>
                </div>
              </div>
              <Chip tone={ord.status === "REJECTED" ? "rose" : ord.status === "WORKING" ? "amber" : "emerald"}>{ord.status}</Chip>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── Modal 1: Connect Real Wallet ─────────────────────────────────── */

function ConnectWalletModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const [chain, setChain] = useState<SupportedChain>("base");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [connectionType, setConnectionType] = useState<ConnectedWallet["connectionType"]>("address_watch");
  const [keyOrSecret, setKeyOrSecret] = useState("");
  const [dailyLimitUsd, setDailyLimitUsd] = useState("0");
  const [showKey, setShowKey] = useState(false);

  const selectedMeta = CHAIN_META[chain];

  const pickChain = (next: SupportedChain) => {
    setChain(next);
    if (next === "stripe" || next === "razorpay") setConnectionType("api_key");
    else setConnectionType("address_watch");
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) {
      window.alert("Enter the public address or account id.");
      return;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      window.alert("That looks like a private key. Paste the public address. A key can be stored below and is not used to sign.");
      return;
    }
    if ((chain === "stripe" || chain === "razorpay") && connectionType === "address_watch") {
      window.alert("Stripe and Razorpay need an API key to read a balance. A typed amount is not accepted.");
      return;
    }
    if ((chain === "stripe" || chain === "razorpay") && !keyOrSecret.trim()) {
      window.alert("Paste the API key. Watch-only cannot read this balance.");
      return;
    }
    const saved = await run("connect_watched_wallet", {
      request: {
        chain,
        label: label.trim(),
        address: trimmed,
        connectionType,
        secret: keyOrSecret.trim(),
        dailyLimitUsd: Number(dailyLimitUsd) || 0,
      },
    });
    if (saved) onClose();
  };

  const inputCls =
    "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-800 text-white flex items-center justify-center">
              <Wallet size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Connect Real Wallet or Rails</h2>
              <p className="text-[11px] text-slate-400">Link multi-chain accounts to authorize agent payments.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleConnect} className="p-5 space-y-4 overflow-y-auto max-h-[75vh]">
          {/* Select Chain */}
          <div className="space-y-1.5">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Network / Rail</span>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(CHAIN_META) as SupportedChain[]).map((c) => {
                const meta = CHAIN_META[c];
                const active = chain === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => pickChain(c)}
                    className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition-all cursor-pointer ${
                      active
                        ? "border-slate-900 bg-slate-50 ring-1 ring-slate-900"
                        : "border-slate-200 hover:border-slate-300 bg-white"
                    }`}
                  >
                    <meta.icon size={14} className={meta.iconClass.split(" ")[1]} />
                    <span className="text-xs font-semibold text-slate-800 truncate">{meta.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Label */}
          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Wallet Nickname</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`e.g. ${selectedMeta.name} Primary`}
              className={inputCls}
            />
          </label>

          {/* Public Address */}
          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Public Address / Identifier</span>
            <input
              type="text"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={selectedMeta.placeholder}
              className={inputCls}
            />
          </label>

          {/* Security & Connection Mode */}
          <div className="space-y-1.5">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Execution Mode</span>
            <select
              value={connectionType}
              onChange={(e) => setConnectionType(e.target.value as ConnectedWallet["connectionType"])}
              className={inputCls}
            >
              <option value="address_watch">Watch only. Read the public balance.</option>
              <option value="api_key">API key. Required for Stripe and Razorpay.</option>
              <option value="private_key_vault">Store a key in the vault. It is not used to sign.</option>
            </select>
          </div>

          {/* Signer Key if Autonomous */}
          {connectionType !== "address_watch" ? (
            <label className="space-y-1 block">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">
                  {connectionType === "api_key" ? "API Key or Secret" : "Private Key / Mnemonic Phrase"}
                </span>
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="text-[10.5px] text-slate-400 hover:text-slate-600 font-semibold"
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
              <input
                type={showKey ? "text" : "password"}
                value={keyOrSecret}
                onChange={(e) => setKeyOrSecret(e.target.value)}
                placeholder="Optional. Stored in the local vault. Not used to sign or to charge a card."
                className={inputCls}
              />
              {chain === "razorpay" ? (
                <span className="text-[10px] text-slate-400 block">Paste the Razorpay pair as key_id:key_secret. A UPI id alone does not prove a balance.</span>
              ) : null}
            </label>
          ) : null}

          {/* Daily Spend Limit */}
          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Note on this wallet (USD)</span>
            <input
              type="number"
              min="1"
              value={dailyLimitUsd}
              onChange={(e) => setDailyLimitUsd(e.target.value)}
              className={inputCls}
            />
          </label>

          {/* Submit */}
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-semibold px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="text-xs font-bold px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
            >
              <Check size={13} /> {busy ? "Reading balance…" : "Read live balance"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Modal 2: Deposit / Top-up Real Money ─────────────────────────── */

function DepositModal({
  wallets,
  initialWallet,
  onClose,
}: {
  wallets: ConnectedWallet[];
  initialWallet: ConnectedWallet | null;
  onClose: () => void;
}) {
  const [selectedWalletId, setSelectedWalletId] = useState(initialWallet?.id || wallets[0]?.id || "");
  const [copied, setCopied] = useState(false);
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  const wallet = wallets.find((w) => w.id === selectedWalletId) || wallets[0];
  const meta = wallet ? CHAIN_META[wallet.chain] : CHAIN_META.base;

  const copyAddress = () => {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const refreshBalance = async () => {
    if (!wallet) return;
    const saved = await run("refresh_wallet_balance", { id: wallet.id });
    if (saved) onClose();
  };

  const inputCls =
    "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500 text-white flex items-center justify-center">
              <ArrowDownLeft size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Receive funds, then refresh</h2>
              <p className="text-[11px] text-slate-400">Send funds yourself. A typed amount is not credited.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto max-h-[75vh]">
          {/* Select destination wallet */}
          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Destination Wallet</span>
            <select
              value={selectedWalletId}
              onChange={(e) => setSelectedWalletId(e.target.value)}
              className={inputCls}
            >
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} ({CHAIN_META[w.chain].name})
                </option>
              ))}
            </select>
          </label>

          {/* Deposit QR & Address Box */}
          {wallet ? (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col items-center text-center space-y-3">
              <div className="w-28 h-28 bg-white border border-slate-200 rounded-xl flex items-center justify-center p-2 shadow-xs">
                {/* Visual SVG QR representation */}
                <div className="w-full h-full bg-slate-900 rounded-lg flex items-center justify-center text-white">
                  <QrCode size={56} className="text-white" />
                </div>
              </div>

              <div className="w-full">
                <span className="text-[10px] text-slate-400 font-bold uppercase block">Deposit Address ({meta.currency})</span>
                <p className="text-xs font-mono font-bold text-slate-800 break-all bg-white border border-slate-200 rounded-xl px-3 py-2 mt-1">
                  {wallet.address}
                </p>
              </div>

              <button
                type="button"
                onClick={copyAddress}
                className="text-xs font-semibold px-4 py-1.5 rounded-full bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 transition-all cursor-pointer flex items-center gap-1.5"
              >
                {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                {copied ? "Copied to clipboard!" : "Copy Deposit Address"}
              </button>
            </div>
          ) : null}

          <div className="border-t border-slate-100 pt-3 space-y-3">
            <p className="text-xs text-slate-600 leading-relaxed">
              Move the funds in your own wallet, exchange, or bank. Then refresh. The next read replaces the balance. It does not add the amount you type.
            </p>
            <button
              type="button"
              disabled={busy || !wallet}
              onClick={() => void refreshBalance()}
              className="w-full text-xs font-bold px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              <Activity size={13} /> {busy ? "Reading…" : "Refresh on-chain balance"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Modal 3: Send / Transfer Real Money ──────────────────────────── */

function ledgerNative(rail: string, amountUsd: number): string {
  if (rail === "razorpay_upi") return `₹${Math.round(amountUsd * 83)}`;
  if (rail === "stripe_card") return `$${amountUsd.toFixed(2)}`;
  return `${amountUsd.toFixed(2)} USDC`;
}

function TransferModal({
  wallets,
  balances,
  initialWallet,
  approvalAbove,
  askPin,
  onClose,
}: {
  wallets: ConnectedWallet[];
  balances: Balance[];
  initialWallet: ConnectedWallet | null;
  approvalAbove: number;
  askPin: (label: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const rails = Object.keys(RAIL_META);
  const startingRail = initialWallet && initialWallet.chain in CHAIN_META
    ? CHAIN_META[initialWallet.chain].railKey
    : balances[0]?.rail || "crypto_x402";
  const [rail, setRail] = useState(rails.includes(startingRail) ? startingRail : "crypto_x402");
  const [sourceId, setSourceId] = useState(initialWallet?.id || "");
  const [counterparty, setCounterparty] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  const ledger = balances.find((row) => row.rail === rail);
  const available = ledger?.amountUsd ?? 0;
  const source = wallets.find((wallet) => wallet.id === sourceId) ?? null;
  const sourceFrozen = source?.status === "frozen" && CHAIN_META[source.chain].railKey === rail;
  const watchedOnRail = wallets.filter((wallet) => CHAIN_META[wallet.chain].railKey === rail);

  const inputCls =
    "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const amountUsd = Number(amount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    const dest = counterparty.trim();
    if (!dest) {
      setError("Enter who this ledger spend is for.");
      return;
    }
    if (sourceFrozen) {
      setError("This wallet is frozen. Unfreeze it before recording a spend on its rail.");
      return;
    }
    if (available + 1e-9 < amountUsd) {
      setError(`The ${railLabel(rail)} ledger has ${money(available)}. Nothing was recorded. The chain balance on a connected card is a read and is not reduced.`);
      return;
    }
    if (amountUsd > approvalAbove) {
      const pinSet = useRonic.getState().snap?.walletPinSet === true;
      if (!pinSet) onClose();
      const ok = await askPin("Enter your wallet PIN to record this ledger spend. There is no default PIN.");
      if (!ok) return;
    }
    const note = purpose.trim() || (source ? `Ledger spend from ${source.label}` : "Operator ledger spend");
    const saved = await run("wallet_tx", {
      request: {
        botProfileId: "",
        rail,
        amountUsd,
        nativeAmount: ledgerNative(rail, amountUsd),
        counterparty: dest,
        purpose: note,
        actor: "user",
        kind: "transfer",
        effect: "spend",
        slippageBps: null,
      },
    });
    if (!saved) {
      setError(useRonic.getState().toast || "The ledger did not record this spend.");
      return;
    }
    const toast = saved.toast ?? "";
    if (/rejected|blocked|too low|cannot move|unknown ledger|no funds/i.test(toast)) {
      setError(toast);
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-500 text-white flex items-center justify-center">
              <ArrowUpRight size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Record a ledger spend</h2>
              <p className="text-[11px] text-slate-400">Policy gate only. No chain signature and no card charge.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4 overflow-y-auto max-h-[75vh]">
          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Ledger rail</span>
            <select value={rail} onChange={(e) => setRail(e.target.value)} className={inputCls}>
              {rails.map((key) => (
                <option key={key} value={key}>{railLabel(key)}</option>
              ))}
            </select>
          </label>

          {wallets.length > 0 ? (
            <label className="space-y-1 block">
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Note a connected card</span>
              <select
                value={sourceId}
                onChange={(e) => {
                  const next = e.target.value;
                  setSourceId(next);
                  const wallet = wallets.find((item) => item.id === next);
                  if (wallet) setRail(CHAIN_META[wallet.chain].railKey);
                }}
                className={inputCls}
              >
                <option value="">Ledger only</option>
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.label} ({CHAIN_META[wallet.chain].name})
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3.5 space-y-1">
            <p className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Available on this ledger</p>
            <p className="text-lg font-bold text-slate-900 font-mono">{ledger?.nativeAmount ?? money(0)}</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {money(available)} can leave this rail. A connected card
              {watchedOnRail.length > 0
                ? ` currently reads ${money(watchedOnRail.reduce((sum, wallet) => sum + (wallet.balanceUsd || 0), 0))}`
                : " is a separate chain read"}
              . Refresh updates that read. This spend does not.
            </p>
          </div>

          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Counterparty</span>
            <input
              required
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="Address, UPI id, or a name on the ledger"
              className={inputCls}
            />
          </label>

          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Amount (USD)</span>
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={inputCls}
            />
          </label>

          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Purpose</span>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="What this ledger row is for"
              className={inputCls}
            />
          </label>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            A stored private key is not used to sign. Watch-only cannot move chain funds. Amounts above {money(approvalAbove)} ask for the wallet PIN, then the kernel records the row. An empty ledger is refused.
          </p>

          {error ? <p className="text-[11px] font-semibold text-rose-600 leading-relaxed">{error}</p> : null}

          <div className="pt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-semibold px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || available <= 0 || sourceFrozen}
              className="text-xs font-bold px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
            >
              <ArrowUpRight size={13} /> {busy ? "Recording…" : "Record ledger spend"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Modal 4: Adjust Bot Budget ───────────────────────────────────── */

function AdjustBotBudgetModal({
  bot,
  onClose,
}: {
  bot: BotProfile;
  onClose: () => void;
}) {
  const snap = useRonic((s) => s.snap)!;
  const verified = verifiedPortfolioUsd(snap.connectedWallets);
  const [dailyLimit, setDailyLimit] = useState(String(bot.dailyWalletLimitUsd ?? 0));
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const limit = Number(dailyLimit);
    if (!Number.isFinite(limit) || limit < 0) return;
    const saved = await run("assign_bot_spend", { botId: bot.id, limitUsd: limit });
    if (saved) onClose();
  };

  const inputCls =
    "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-800 text-white flex items-center justify-center">
              <Bot size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Assign Real Money Budget</h2>
              <p className="text-[11px] text-slate-400">Set daily spending ceiling for @{bot.handle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-4">
          <div className="p-3 bg-slate-50 rounded-2xl border border-slate-100 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-slate-200 text-slate-700 font-bold flex items-center justify-center text-xs">
              {bot.handle.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <span className="text-xs font-bold text-slate-800">@{bot.handle}</span>
              <p className="text-[11px] text-slate-500">{bot.displayName || bot.role || "Autonomous Agent"}</p>
            </div>
          </div>

          <label className="space-y-1 block">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">Daily Spending Budget (USD)</span>
            <input
              type="number"
              min="0"
              required
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              className={inputCls}
            />
          </label>

          {/* Quick presets */}
          <div className="flex items-center gap-2 flex-wrap">
            {[10, 25, 50, 100, 250, 500].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setDailyLimit(String(preset))}
                className={`text-[11px] font-semibold px-3 py-1 rounded-full border transition-all cursor-pointer ${
                  Number(dailyLimit) === preset
                    ? "bg-zinc-800 text-white border-zinc-700"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                }`}
              >
                ${preset}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            Verified wallets currently show {money(verified)}. The budget cannot be higher than that. The policy gate still blocks a spend above {money(Number(dailyLimit) || 0)} in a day.
          </p>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-semibold px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="text-xs font-bold px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
            >
              <Check size={13} /> Save Spending Limit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Minor Atoms ─────────────────────────────────────────────────── */

function RailCard({ meta, balance }: { rail: string; meta: (typeof RAIL_META)[string]; balance?: Balance }) {
  const Icon = meta.icon;
  return (
    <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className={`w-8 h-8 rounded-xl border flex items-center justify-center ${meta.iconClass}`}>
          <Icon size={14} />
        </span>
        <span className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded-md ${meta.badgeClass}`}>
          {meta.badge}
        </span>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-slate-500 leading-tight">{meta.label}</p>
        <p className="text-xl font-bold text-slate-900 tracking-tight font-mono mt-0.5">{balance?.nativeAmount ?? "—"}</p>
      </div>
      <p className="text-[10.5px] text-slate-400 leading-relaxed">{meta.note}</p>
    </article>
  );
}

function RailSpendCard({ spentToday, dailyCap, totalRebate }: { spentToday: number; dailyCap: number; totalRebate: number }) {
  return (
    <article className="bg-slate-900 border border-slate-900 rounded-2xl p-4 shadow-xs space-y-2.5 text-white">
      <div className="flex items-center justify-between gap-2">
        <span className="w-8 h-8 rounded-xl bg-white/10 border border-white/10 flex items-center justify-center text-emerald-300">
          <ArrowLeftRight size={14} />
        </span>
        <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-white/10 text-slate-200 border border-white/10">TODAY</span>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-slate-300 leading-tight">Spent today by agents</p>
        <p className="text-xl font-bold tracking-tight font-mono mt-0.5">{money(spentToday)}</p>
      </div>
      <p className="text-[10.5px] text-slate-400 leading-relaxed">
        Daily cap {money(dailyCap)} · builder rebate accrued {money(totalRebate)}
      </p>
    </article>
  );
}

function NumberField({
  label,
  value,
  onCommit,
  inputCls,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  inputCls: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <input
        className={inputCls}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = Number(text);
          if (text.trim() === "" || !Number.isFinite(next)) {
            setText(String(value));
            return;
          }
          onCommit(next);
        }}
      />
    </label>
  );
}

function railLabel(rail: string) {
  return RAIL_META[rail]?.label ?? rail;
}
