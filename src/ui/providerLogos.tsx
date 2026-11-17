import type { CSSProperties } from "react";

export type ProviderBrand = {
  id: string;
  name: string;
  /** SVG viewBox paths (24x24 grid) */
  paths: string[];
  /** Brand gradient for the tile background */
  gradient: string;
  /** Foreground / icon color */
  fg: string;
  /** Optional text mark used as fallback */
  mark: string;
};

/**
 * Official-style brand marks, hand-tuned on a 24×24 grid.
 * Kept inline so no network fetches, no tracking, instant paint.
 */
const BRANDS: Record<string, ProviderBrand> = {
  prov_chatgpt: {
    id: "prov_chatgpt",
    name: "ChatGPT",
    paths: [
      "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm5.6 6.2-3.1 1.8V6.6a2.6 2.6 0 0 0-1.3-2.3l3.1 1.8a2.6 2.6 0 0 1 1.3 2.1Zm-1.3 7.5-3.1-1.8h3.5a2.6 2.6 0 0 0 2.6-2.6v-.1l-3.1 1.8v3.5a2.6 2.6 0 0 1-1.2 2.2l-3.1-1.8a2.6 2.6 0 0 0 0-4.5V8.6l3.1 1.8a2.6 2.6 0 0 1 1.3 2.2Zm-8.6 2.2a2.6 2.6 0 0 1-2.6-2.6V15l3.1-1.8h-3.5a2.6 2.6 0 0 1-1.3-4.9l3.1 1.8v3.5a2.6 2.6 0 0 0 1.3 2.3ZM6.4 9.9l3.1-1.8v3.5a2.6 2.6 0 0 0 0 4.5l-3.1 1.8a2.6 2.6 0 0 1-1.3-2.2l3.1-1.8H4.6a2.6 2.6 0 0 1 1.3-4.9l3.1 1.8V7.6a2.6 2.6 0 0 0-2.6 2.3Zm11.2 4.2V14l-3.1 1.8h3.5a2.6 2.6 0 0 1 1.3 4.9l-3.1-1.8v-3.5a2.6 2.6 0 0 0-1.3-2.3Zm-4.3 6.2a2.6 2.6 0 0 1-2.6-2.6l3.1 1.8 3.1-1.8a2.6 2.6 0 0 1-3.6 2.6Z",
    ],
    gradient: "linear-gradient(135deg,#10a37f 0%,#0d8a6c 100%)",
    fg: "#ffffff",
    mark: "AI",
  },
  prov_anthropic: {
    id: "prov_anthropic",
    name: "Claude",
    paths: [
      "M17.3 3H6.7L3 8.2v7.6L6.7 21h10.6l3.7-5.2V8.2L17.3 3Zm-2.6 4.1-4.5 9.8H8l4.5-9.8h2.2Z",
    ],
    gradient: "linear-gradient(135deg,#d97757 0%,#c25a3a 100%)",
    fg: "#ffffff",
    mark: "CL",
  },
  prov_claude: {
    id: "prov_claude",
    name: "Claude Code",
    paths: [
      "M17.3 3H6.7L3 8.2v7.6L6.7 21h10.6l3.7-5.2V8.2L17.3 3Zm-2.6 4.1-4.5 9.8H8l4.5-9.8h2.2Z",
    ],
    gradient: "linear-gradient(135deg,#d97757 0%,#a84c30 100%)",
    fg: "#ffffff",
    mark: "CC",
  },
  prov_gemini: {
    id: "prov_gemini",
    name: "Gemini",
    paths: [
      "M12 2 9.9 9.9 2 12l7.9 2.1L12 22l2.1-7.9L22 12l-7.9-2.1L12 2Z",
    ],
    gradient: "linear-gradient(135deg,#4285f4 0%,#9b72cb 60%,#d96570 100%)",
    fg: "#ffffff",
    mark: "GE",
  },
  prov_grok: {
    id: "prov_grok",
    name: "Grok",
    paths: [
      "M4 3h4l4 5 4-5h4l-6 7.5L20 21h-4l-4-6-4 6H4l6-8.5L4 3Z",
    ],
    gradient: "linear-gradient(135deg,#1d1d1f 0%,#3a3a3c 100%)",
    fg: "#ffffff",
    mark: "𝕏",
  },
  prov_mistral: {
    id: "prov_mistral",
    name: "Mistral",
    paths: [
      "M3 3h4v4H3V3Zm7 0h4v4h-4V3Zm7 0h4v4h-4V3ZM3 10h4v4H3v-4Zm14 0h4v4h-4v-4ZM3 17h4v4H3v-4Zm7 0h4v4h-4v-4Zm7 0h4v4h-4v-4Z",
    ],
    gradient: "linear-gradient(135deg,#ff7000 0%,#fa500f 100%)",
    fg: "#ffffff",
    mark: "MI",
  },
  prov_perplexity: {
    id: "prov_perplexity",
    name: "Perplexity",
    paths: [
      "M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 3.2L17.5 8 12 11 6.5 8 12 5.2ZM5 9.6l6 3.4v6.6l-6-3.4V9.6Zm8 10V13l6-3.4v6.6l-6 3.4Z",
    ],
    gradient: "linear-gradient(135deg,#20808d 0%,#155e66 100%)",
    fg: "#ffffff",
    mark: "PX",
  },
  prov_groq: {
    id: "prov_groq",
    name: "Groq",
    paths: [
      "M12 2a10 10 0 1 0 10 10h-4a6 6 0 1 1-6-6V2Zm0 5a5 5 0 1 0 5 5h-5V7Z",
    ],
    gradient: "linear-gradient(135deg,#f55036 0%,#d63a22 100%)",
    fg: "#ffffff",
    mark: "GQ",
  },
  prov_together: {
    id: "prov_together",
    name: "Together",
    paths: [
      "M12 2a7 7 0 0 0-7 7c0 2.4 1.2 4.4 3 5.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3c1.8-1.3 3-3.3 3-5.7a7 7 0 0 0-7-7Zm-2 17h4v1a2 2 0 0 1-4 0v-1Z",
    ],
    gradient: "linear-gradient(135deg,#0f6fde 0%,#0a4fa0 100%)",
    fg: "#ffffff",
    mark: "TG",
  },
  prov_deepseek: {
    id: "prov_deepseek",
    name: "DeepSeek",
    paths: [
      "M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9Zm4.5 0c0 2.5 2 4.5 4.5 4.5s4.5-2 4.5-4.5-2-4.5-4.5-4.5-4.5 2-4.5 4.5Z",
    ],
    gradient: "linear-gradient(135deg,#4d6bfe 0%,#2e46c4 100%)",
    fg: "#ffffff",
    mark: "DS",
  },
  prov_openrouter: {
    id: "prov_openrouter",
    name: "OpenRouter",
    paths: [
      "M4 4h16v4H4V4Zm0 6h10v4H4v-4Zm0 6h16v4H4v-4Z",
    ],
    gradient: "linear-gradient(135deg,#6366f1 0%,#4338ca 100%)",
    fg: "#ffffff",
    mark: "OR",
  },
  prov_cohere: {
    id: "prov_cohere",
    name: "Cohere",
    paths: [
      "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm-4 9a2 2 0 1 1 2 2 2 2 0 0 1-2-2Zm6 0a2 2 0 1 1 2 2 2 2 0 0 1-2-2Zm-7 5h10a5 5 0 0 1-10 0Z",
    ],
    gradient: "linear-gradient(135deg,#39594d 0%,#d18ee2 100%)",
    fg: "#ffffff",
    mark: "CO",
  },
  prov_qwen: {
    id: "prov_qwen",
    name: "Qwen",
    paths: [
      "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 4a6 6 0 0 1 6 6h-4a2 2 0 0 0-4 0v4a6 6 0 0 1-6-6 6 6 0 0 1 8-5.7V6Z",
    ],
    gradient: "linear-gradient(135deg,#a855f7 0%,#7e22ce 100%)",
    fg: "#ffffff",
    mark: "QW",
  },
  prov_ollama: {
    id: "prov_ollama",
    name: "Ollama",
    paths: [
      "M8 3a5 5 0 0 0-5 5v1H2v3h1v1a5 5 0 0 0 5 5h8a5 5 0 0 0 5-5v-1h1V9h-1V8a5 5 0 0 0-5-5H8Zm-2 6h12v4a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9Zm2 1v2h2v-2H8Zm6 0v2h2v-2h-2Z",
    ],
    gradient: "linear-gradient(135deg,#1f2937 0%,#000000 100%)",
    fg: "#ffffff",
    mark: "OL",
  },
  prov_bedrock: {
    id: "prov_bedrock",
    name: "Bedrock",
    paths: [
      "M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.5 3.6L12 11.5 5.5 7.9 12 4.3ZM5 9.6l6 3.3v6.8l-6-3.3V9.6Zm8 10.1v-6.8l6-3.3v6.8l-6 3.3Z",
    ],
    gradient: "linear-gradient(135deg,#ff9900 0%,#ec7211 100%)",
    fg: "#232f3e",
    mark: "BR",
  },
  prov_nvidia: {
    id: "prov_nvidia",
    name: "NVIDIA",
    paths: [
      "M12 7c-3 0-6 1.6-9 4.5C5.4 15 8.4 17 12 17s6.6-2 9-5.5C18 8.6 15 7 12 7Zm0 2c2.2 0 4.2 1.1 6.2 3-2 1.9-4 3-6.2 3s-4.2-1.1-6.2-3c2-1.9 4-3 6.2-3Zm0 1.5A1.5 1.5 0 1 0 13.5 12 1.5 1.5 0 0 0 12 10.5Z",
    ],
    gradient: "linear-gradient(135deg,#76b900 0%,#4d7c00 100%)",
    fg: "#ffffff",
    mark: "NV",
  },
  prov_tokenrouter: {
    id: "prov_tokenrouter",
    name: "TokenRouter",
    paths: [
      "M4 4h16v6H4V4Zm0 10h16v6H4v-6Zm3-7v2h2V7H7Zm0 10v2h2v-2H7Z",
    ],
    gradient: "linear-gradient(135deg,#0ea5e9 0%,#0369a1 100%)",
    fg: "#ffffff",
    mark: "TR",
  },
};

/** Lookup with fuzzy matching so unknown / custom providers still get a tile. */
export function brandFor(idOrName: string): ProviderBrand | undefined {
  if (!idOrName) return undefined;
  const key = idOrName.toLowerCase();
  if (BRANDS[idOrName]) return BRANDS[idOrName];
  // Match by id substring or name
  for (const brand of Object.values(BRANDS)) {
    if (key.includes(brand.id.replace("prov_", ""))) return brand;
    if (key.includes(brand.name.toLowerCase())) return brand;
  }
  if (key.includes("openai") || key.includes("chatgpt") || key.includes("gpt")) return BRANDS.prov_chatgpt;
  if (key.includes("claude") || key.includes("anthropic")) return BRANDS.prov_anthropic;
  if (key.includes("gemini") || key.includes("google")) return BRANDS.prov_gemini;
  if (key.includes("grok") || key.includes("xai") || key.includes("x.ai")) return BRANDS.prov_grok;
  if (key.includes("mistral")) return BRANDS.prov_mistral;
  if (key.includes("perplex")) return BRANDS.prov_perplexity;
  if (key.includes("groq")) return BRANDS.prov_groq;
  if (key.includes("together")) return BRANDS.prov_together;
  if (key.includes("deepseek")) return BRANDS.prov_deepseek;
  if (key.includes("openrouter")) return BRANDS.prov_openrouter;
  if (key.includes("cohere")) return BRANDS.prov_cohere;
  if (key.includes("qwen")) return BRANDS.prov_qwen;
  if (key.includes("ollama")) return BRANDS.prov_ollama;
  if (key.includes("bedrock") || key.includes("aws")) return BRANDS.prov_bedrock;
  if (key.includes("nvidia")) return BRANDS.prov_nvidia;
  return undefined;
}

export function ProviderLogo({
  id,
  name,
  size = 40,
  radius,
  className = "",
}: {
  id?: string;
  name: string;
  size?: number;
  radius?: number;
  className?: string;
}) {
  const brand = brandFor(id || name);
  const r = radius ?? Math.round(size * 0.28);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: r,
    background: brand?.gradient ?? "linear-gradient(135deg,#64748b 0%,#334155 100%)",
    color: brand?.fg ?? "#ffffff",
  };
  return (
    <span
      className={`provider-logo ${className}`}
      style={style}
      role="img"
      aria-label={`${name} logo`}
    >
      {brand ? (
        <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} fill="currentColor" aria-hidden="true">
          {brand.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      ) : (
        <span className="provider-logo-fallback" style={{ fontSize: size * 0.4 }}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/** All known brands, useful for a "popular providers" picker. */
export const POPULAR_BRANDS: ProviderBrand[] = [
  BRANDS.prov_chatgpt,
  BRANDS.prov_anthropic,
  BRANDS.prov_gemini,
  BRANDS.prov_grok,
  BRANDS.prov_mistral,
  BRANDS.prov_deepseek,
  BRANDS.prov_perplexity,
  BRANDS.prov_groq,
  BRANDS.prov_together,
  BRANDS.prov_openrouter,
  BRANDS.prov_cohere,
  BRANDS.prov_qwen,
  BRANDS.prov_ollama,
];
