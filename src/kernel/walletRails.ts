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

export interface ChainMetadata {
  name: string;
  currency: string;
  iconClass: string;
  badgeClass: string;
  railKey: string;
  explorerBase: string;
  placeholder: string;
  defaultNote: string;
}

export const CHAIN_META: Record<SupportedChain, ChainMetadata> = {
  base: {
    name: "Base (USDC x402 & ETH)",
    currency: "USDC",
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
    iconClass: "bg-amber-50 text-amber-600 border-amber-100",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200/80",
    railKey: "razorpay_upi",
    explorerBase: "https://dashboard.razorpay.com/",
    placeholder: "merchant@upi or VPA ID",
    defaultNote: "Instant UPI payment links & vendor payouts (₹400 auto-cap)",
  },
};

export function validateWalletAddress(chain: SupportedChain, address: string): { valid: boolean; reason?: string } {
  const trimmed = address.trim();
  if (!trimmed) {
    return { valid: false, reason: "Address cannot be empty" };
  }

  if (["base", "ethereum", "arbitrum", "polygon", "hyperliquid"].includes(chain)) {
    if (!trimmed.startsWith("0x") || trimmed.length < 10) {
      return { valid: false, reason: "EVM / Hex address must start with 0x" };
    }
  } else if (chain === "solana") {
    if (trimmed.length < 32 || trimmed.length > 44) {
      return { valid: false, reason: "Invalid Solana public key length" };
    }
  } else if (chain === "razorpay") {
    if (!trimmed.includes("@") && !trimmed.startsWith("vpa_")) {
      return { valid: false, reason: "Invalid UPI VPA handle" };
    }
  }

  return { valid: true };
}

export function evaluatePolicyMovement(
  policy: {
    maxPerTxUsd: number;
    dailyCapUsd: number;
    requireHumanApprovalAboveUsd: number;
    killswitchEngaged: boolean;
  },
  amountUsd: number,
  spentTodayUsd: number,
  isCredit: boolean
): "auto_signed" | "pending_approval" | "rejected_killswitch" | "rejected_daily_cap" {
  if (policy.killswitchEngaged && !isCredit) {
    return "rejected_killswitch";
  }

  if (!isCredit && spentTodayUsd + amountUsd > policy.dailyCapUsd + 1e-6) {
    return "rejected_daily_cap";
  }

  if (!isCredit && amountUsd > policy.requireHumanApprovalAboveUsd) {
    return "pending_approval";
  }

  return "auto_signed";
}

export function calculateBotSpendProgress(spentToday: number, dailyLimit: number): {
  pct: number;
  isOverBudget: boolean;
  statusColor: "emerald" | "amber" | "rose";
} {
  if (dailyLimit <= 0) {
    return { pct: 0, isOverBudget: spentToday > 0, statusColor: spentToday > 0 ? "rose" : "emerald" };
  }
  const pct = Math.min(100, Math.round((spentToday / dailyLimit) * 100));
  const isOverBudget = spentToday > dailyLimit;
  let statusColor: "emerald" | "amber" | "rose" = "emerald";
  if (pct > 90 || isOverBudget) statusColor = "rose";
  else if (pct > 70) statusColor = "amber";

  return { pct, isOverBudget, statusColor };
}

