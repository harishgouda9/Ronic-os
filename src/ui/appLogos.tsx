import { useState, useMemo, useEffect } from "react";
import {
  Brain,
  Clock,
  Database,
  FileCode,
  Folder,
  GitBranch,
  Globe,
  Layers,
  Lock,
  Puzzle,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";

type Logo = { bg: string; fg: string; viewBox: string; paths: string[] };

const ANTHROPIC =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

export const BRAND_DOMAINS: Record<string, string> = {
  notion: "notion.so",
  linear: "linear.app",
  sentry: "sentry.io",
  supabase: "supabase.com",
  composio: "composio.dev",
  github: "github.com",
  slack: "slack.com",
  stripe: "stripe.com",
  figma: "figma.com",
  canva: "canva.com",
  gitlab: "gitlab.com",
  datadog: "datadoghq.com",
  vercel: "vercel.com",
  cloudflare: "cloudflare.com",
  postman: "postman.com",
  "hugging face": "huggingface.co",
  huggingface: "huggingface.co",
  playwright: "playwright.dev",
  docker: "docker.com",
  "1password": "1password.com",
  bitwarden: "bitwarden.com",
  lastpass: "lastpass.com",
  atlassian: "atlassian.com",
  jira: "atlassian.com",
  trello: "trello.com",
  onedrive: "onedrive.live.com",
  gmail: "mail.google.com",
  "google calendar": "calendar.google.com",
  "google slides": "slides.google.com",
  outlook: "outlook.live.com",
  mobbin: "mobbin.com",
  x: "x.com",
  twitter: "x.com",
  discord: "discord.com",
  telegram: "telegram.org",
  airtable: "airtable.com",
  hubspot: "hubspot.com",
  salesforce: "salesforce.com",
  zendesk: "zendesk.com",
  asana: "asana.com",
  clickup: "clickup.com",
  monday: "monday.com",
  obsidian: "obsidian.md",
  vscode: "code.visualstudio.com",
  postgres: "postgresql.org",
  postgresql: "postgresql.org",
  groq: "groq.com",
  together: "together.ai",
  "together ai": "together.ai",
  mistral: "mistral.ai",
  "mistral ai": "mistral.ai",
  perplexity: "perplexity.ai",
  deepseek: "deepseek.com",
  xai: "x.ai",
  grok: "x.ai",
  openrouter: "openrouter.ai",
  ollama: "ollama.com",
  brave: "brave.com",
  sqlite: "sqlite.org",
  redis: "redis.io",
  mysql: "mysql.com",
  mongodb: "mongodb.com",
  aws: "aws.amazon.com",
  azure: "azure.microsoft.com",
  zoom: "zoom.us",
  whatsapp: "whatsapp.com",
  linkedin: "linkedin.com",
  superpowers: "superpowers.ai",
  razorpay: "razorpay.com",
  puppeteer: "pptr.dev",
  exa: "exa.ai",
  "exa ai": "exa.ai",
  "brave search": "brave.com",
  "google drive": "drive.google.com",
  "google maps": "maps.google.com",
  "google docs": "docs.google.com",
  "google sheets": "sheets.google.com",
  google: "google.com",
  confluence: "atlassian.com",
  posthog: "posthog.com",
  firecrawl: "firecrawl.dev",
  apify: "apify.com",
  granola: "granola.ai",
  apollo: "apollo.io",
  "apollo.io": "apollo.io",
  parallel: "parallel.ai",
  brevo: "brevo.com",
  mailerlite: "mailerlite.com",
  klaviyo: "klaviyo.com",
  shopify: "shopify.com",
  kraken: "kraken.com",
  phantom: "phantom.app",
  ramp: "ramp.com",
  "context.dev": "context.dev",
  ahrefs: "ahrefs.com",
  treg: "treg.dev",
  higgsfield: "higgsfield.ai",
  pstack: "pstack.app",
  bulkpublish: "bulkpublish.io",
  link: "link.com",
  mineru: "opendatalab.org.cn",
  prisma: "prisma.io",
  drizzle: "orm.drizzle.team",
  neondb: "neon.tech",
  neon: "neon.tech",
  upstash: "upstash.com",
  pinecone: "pinecone.io",
  qdrant: "qdrant.tech",
  weaviate: "weaviate.io",
  chromadb: "trychroma.com",
  langchain: "langchain.com",
  langfuse: "langfuse.com",
  cohere: "cohere.com",
  anthropic: "anthropic.com",
  openai: "openai.com",
};

const LOGOS: Record<string, Logo> = {
  chatgpt: {
    bg: "#000000",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    ],
  },
  claude: { bg: "#F4EDE4", fg: "#141413", viewBox: "0 0 24 24", paths: [ANTHROPIC] },
  "claude-code": { bg: "#F4EDE4", fg: "#141413", viewBox: "0 0 24 24", paths: [ANTHROPIC] },
  gemini: {
    bg: "#ffffff",
    fg: "#1A73E8",
    viewBox: "0 0 24 24",
    paths: [
      "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
    ],
  },
  notion: {
    bg: "#ffffff",
    fg: "#000000",
    viewBox: "0 0 24 24",
    paths: [
      "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.83c-.466-.373-.98-.606-2.007-.513L2.873 2.343c-.373.047-.466.28-.326.466zm.793 4.665v12.78c0 .84.42 1.12 1.306 1.073l14.195-.84c.886-.046 1.073-.56 1.073-1.213V7.753c0-.653-.28-.933-.886-.886l-14.755.886c-.653.047-.933.373-.933.933zm13.495 1.073c.093.42 0 .84-.42.886l-1.026.14v8.91l-1.913-.093-4.76-7.51v6.998l1.4.28c.327.046.374.373.374.653 0 .28-.094.42-.42.42l-3.593.233c-.327 0-.42-.14-.42-.42 0-.28.093-.56.373-.607l1.073-.14V11.21l-1.26-.14c-.326-.047-.373-.373-.373-.653 0-.28.14-.42.42-.42l3.78-.233 4.806 7.417V10.79l-1.353-.233c-.327-.047-.374-.374-.374-.654 0-.28.093-.42.42-.42z",
    ],
  },
  linear: {
    bg: "#5E6AD2",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M3.013 14.773a9.96 9.96 0 0 0 6.214 6.214l-6.214-6.214zm1.748-4.708A10.013 10.013 0 0 1 12 2c5.523 0 10 4.477 10 10 0 2.87-1.208 5.457-3.14 7.279L4.76 5.18a9.98 9.98 0 0 1-.001 4.885zm4.846 10.82A9.972 9.972 0 0 1 2 12c0-1.68.414-3.264 1.144-4.655l15.511 15.51A9.957 9.957 0 0 1 9.607 20.885zm11.38-4.098A9.96 9.96 0 0 0 22 12c0-5.523-4.477-10-10-10a9.96 9.96 0 0 0-4.773 1.214l13.76 13.573z",
    ],
  },
  sentry: {
    bg: "#362D59",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M13.91 3.52c-.67-.67-1.74-.67-2.41 0L2.83 12.19c-.67.67-.67 1.74 0 2.41l8.67 8.67c.67.67 1.74.67 2.41 0l8.67-8.67c.67-.67.67-1.74 0-2.41L13.91 3.52zm-1.2 16.92L4.04 13.4 12.71 4.73l8.67 8.67-8.67 8.67v-1.63z",
    ],
  },
  supabase: {
    bg: "#1C1C1C",
    fg: "#3ECF8E",
    viewBox: "0 0 24 24",
    paths: [
      "M21.362 9.354H12V.3a.3.3 0 0 0-.535-.192L.227 13.9a.3.3 0 0 0 .232.492H12v9.308a.3.3 0 0 0 .535.192l11.238-13.792a.3.3 0 0 0-.232-.492z",
    ],
  },
  github: {
    bg: "#24292E",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z",
    ],
  },
  composio: {
    bg: "#18181B",
    fg: "#22C55E",
    viewBox: "0 0 24 24",
    paths: [
      "M12 2a10 10 0 1 0 10 10A10.011 10.011 0 0 0 12 2zm0 17.5A7.5 7.5 0 1 1 19.5 12 7.508 7.508 0 0 1 12 19.5zm2.5-10.5h-5a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V9.5a.5.5 0 0 0-.5-.5z",
    ],
  },
  slack: {
    bg: "#4A154B",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    ],
  },
  stripe: {
    bg: "#635BFF",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C17.652.795 15.064 0 12.227 0 6.643 0 2.766 2.873 2.766 7.625c0 4.676 3.235 6.438 6.746 7.684 2.164.795 3.018 1.488 3.018 2.528 0 .973-.853 1.545-2.28 1.545-2.094 0-4.887-.973-6.832-2.15l-.946 5.568c1.932 1.053 5.093 1.95 8.169 1.95 5.922 0 9.878-2.82 9.878-7.778 0-4.943-3.284-6.471-6.545-7.672z",
    ],
  },
  figma: {
    bg: "#1E1E1E",
    fg: "#F24E1E",
    viewBox: "0 0 24 24",
    paths: [
      "M8 12a4 4 0 1 1 8 0 4 4 0 0 1-8 0zm0-8a4 4 0 0 1 4-4h4a4 4 0 0 1 0 8h-4a4 4 0 0 1-4-4zm0 8a4 4 0 0 1 4-4h4a4 4 0 0 1 0 8h-4a4 4 0 0 1-4-4zm0 8a4 4 0 0 1 4-4v4a4 4 0 1 1-4 0zM4 8a4 4 0 0 1 4-4h4v8H8a4 4 0 0 1-4-4z",
    ],
  },
  vercel: {
    bg: "#000000",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: ["M12 1L24 22H0L12 1Z"],
  },
  cloudflare: {
    bg: "#F38020",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M18.244 9.35A5.992 5.992 0 0 0 12.5 4a5.992 5.992 0 0 0-5.744 5.35A4.5 4.5 0 0 0 2 13.5C2 15.985 4.015 18 6.5 18h11.75a4.75 4.75 0 0 0 0-9.5h-.006z",
    ],
  },
  postman: {
    bg: "#FF6C37",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5v-2h-2v2H9v-4h2v-2H9V8.5h4v2h2v-2h2v4h-2v2h2v2h-4z",
    ],
  },
  huggingface: {
    bg: "#FFD21E",
    fg: "#000000",
    viewBox: "0 0 24 24",
    paths: [
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-3.5 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-3.5 9c-2.33 0-4.31-1.46-5.11-3.5h10.22c-.8 2.04-2.78 3.5-5.11 3.5z",
    ],
  },
  playwright: {
    bg: "#2EAD33",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
    ],
  },
  docker: {
    bg: "#2496ED",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.185.185 0 0 0-.185.186v1.887c0 .102.083.185.185.185zm-2.954-5.43h2.118a.186.186 0 0 0 .186-.186V3.574a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185zm0 2.716h2.118a.187.187 0 0 0 .186-.186V6.29a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.887c0 .102.082.186.185.186zm-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H8.1a.185.185 0 0 0-.185.185v1.887c0 .102.083.186.185.186zm-2.964 0h2.119a.186.186 0 0 0 .185-.186V6.29a.185.185 0 0 0-.185-.185H5.136a.186.186 0 0 0-.186.185v1.887c0 .102.084.186.186.186zm5.893 2.715h2.118a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.186v1.887c0 .102.082.185.185.185zm-2.93 0h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.184-.186H8.1a.185.185 0 0 0-.185.186v1.887c0 .102.083.185.185.185zm-2.964 0h2.119a.185.185 0 0 0 .185-.185V9.006a.185.185 0 0 0-.185-.186H5.136a.186.186 0 0 0-.186.186v1.887c0 .102.084.185.186.185zm-2.928 0h2.119a.185.185 0 0 0 .185-.185V9.006a.185.185 0 0 0-.185-.186H2.208a.186.186 0 0 0-.186.186v1.887c0 .102.084.185.186.185zM23.79 11.23c-.4-.555-1.144-.82-2.148-.79-.22.008-.432.03-.64.068a6.3 6.3 0 0 0-1.848-.992c-.37-.123-.74-.207-1.12-.25v-.012h-3.41V6.634h.01V3.92h-2.73V1.206H7.72v4.428H4.757v2.716H1.83V11.23H.21v2.32c.2 1.34.8 2.62 1.74 3.65a9.38 9.38 0 0 0 4.22 2.37c2.25.57 4.67.43 6.84-.39a13.3 13.3 0 0 0 4.77-3.45c1.8-2.02 2.76-4.57 2.76-4.57.94-.13 1.83-.55 2.5-1.2.32-.3.57-.65.75-1.03z",
    ],
  },
  postgres: {
    bg: "#336791",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5v-2h-2v2H9v-4h2v-2H9V8.5h4v2h2v-2h2v4h-2v2h2v2h-4z",
    ],
  },
  obsidian: {
    bg: "#ffffff",
    fg: "#7C3AED",
    viewBox: "0 0 24 24",
    paths: [
      "M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z",
    ],
  },
  cursor: {
    bg: "#000000",
    fg: "#ffffff",
    viewBox: "0 0 24 24",
    paths: [
      "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
    ],
  },
  vscode: {
    bg: "#ffffff",
    fg: "#007ACC",
    viewBox: "0 0 24 24",
    paths: [
      "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z",
    ],
  },
};

export function getBrandCustomSvg(brandKey: string): React.ReactNode {
  switch (brandKey) {
    case "filesystem":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0284C7" />
          <path d="M6 9a2 2 0 0 1 2-2h5l3 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9z" fill="#38BDF8" />
          <path d="M6 14h20v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8z" fill="#BAE6FD" />
        </svg>
      );
    case "memory":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#7C3AED" />
          <circle cx="16" cy="16" r="3.2" fill="#FFFFFF" />
          <circle cx="10" cy="10" r="2.2" fill="#E9D5FF" />
          <circle cx="22" cy="10" r="2.2" fill="#E9D5FF" />
          <circle cx="10" cy="22" r="2.2" fill="#E9D5FF" />
          <circle cx="22" cy="22" r="2.2" fill="#E9D5FF" />
          <path d="M10 10l6 6M22 10l-6 6M10 22l6-6M22 22l-6-6" stroke="#DDD6FE" strokeWidth="1.8" />
        </svg>
      );
    case "sequential":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#4F46E5" />
          <path d="M9 16h3l2-4 4 8 2-4h3" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16" cy="9" r="1.5" fill="#A5B4FC" />
          <circle cx="23" cy="11" r="1.5" fill="#A5B4FC" />
          <circle cx="9" cy="11" r="1.5" fill="#A5B4FC" />
        </svg>
      );
    case "fetch":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0891B2" />
          <circle cx="16" cy="16" r="9" stroke="#A5F3FC" strokeWidth="1.8" fill="none" />
          <ellipse cx="16" cy="16" rx="4.5" ry="9" stroke="#A5F3FC" strokeWidth="1.8" fill="none" />
          <line x1="7" y1="16" x2="25" y2="16" stroke="#A5F3FC" strokeWidth="1.8" />
          <path d="M14 9l4 4-4 4" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "postgres":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#336791" />
          <path d="M19.5 7c-3 0-5.5 2-6.5 4.5C11 12 9.5 13.5 9 16c-.5 2.5 0 5 1 7l1.5-1c-.5-1.5-.5-3.5 0-5 1 2 2.5 3 4.5 3h1.5v3.5c0 1.5 1 2.5 2 2.5s2-1 2-2.5V20c1.5 0 3-1 3.5-2.5.5-2-.5-4.5-2-5.5.5-1.5.5-3.5-.5-4.5-1-.5-2-.5-3-.5z" fill="#FFFFFF" />
        </svg>
      );
    case "sqlite":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#003B57" />
          <ellipse cx="16" cy="10" rx="9" ry="3.5" fill="#00A8DE" />
          <path d="M7 10v6c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5v-6" stroke="#00A8DE" strokeWidth="2" fill="none" />
          <path d="M7 16v6c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5v-6" stroke="#00A8DE" strokeWidth="2" fill="none" />
          <path d="M13 14l6 4M19 14l-6 4" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "chrome":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <circle cx="16" cy="16" r="12" fill="#FFFFFF" />
          <path d="M16 4a12 12 0 0 1 10.4 6H16z" fill="#EA4335" />
          <path d="M26.4 10A12 12 0 0 1 16 28l5.2-9z" fill="#FBBC05" />
          <path d="M16 28A12 12 0 0 1 5.6 10H16z" fill="#34A853" />
          <circle cx="16" cy="16" r="5" fill="#FFFFFF" />
          <circle cx="16" cy="16" r="3.8" fill="#4285F4" />
        </svg>
      );
    case "brave":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FB542B" />
          <path d="M9 10l3-4h8l3 4 2 8-5 8-4-3-4 3-5-8 2-8z" fill="#FFFFFF" />
          <circle cx="13" cy="14" r="1.5" fill="#FB542B" />
          <circle cx="19" cy="14" r="1.5" fill="#FB542B" />
          <path d="M14 18h4l-2 3-2-3z" fill="#FB542B" />
        </svg>
      );
    case "terminal":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#090D16" />
          <path d="M9 11l5 5-5 5" stroke="#10B981" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="17" y1="21" x2="23" y2="21" stroke="#10B981" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "mineru":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#6D28D9" />
          <rect x="8" y="7" width="16" height="18" rx="2" stroke="#E9D5FF" strokeWidth="1.8" fill="none" />
          <line x1="6" y1="16" x2="26" y2="16" stroke="#F43F5E" strokeWidth="2" strokeDasharray="2 2" />
          <rect x="11" y="11" width="10" height="2" rx="1" fill="#FFFFFF" />
          <rect x="11" y="19" width="7" height="2" rx="1" fill="#FFFFFF" />
        </svg>
      );
    case "codebase-memory":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#4338CA" />
          <circle cx="16" cy="9" r="2.5" fill="#C7D2FE" />
          <circle cx="10" cy="22" r="2.5" fill="#C7D2FE" />
          <circle cx="22" cy="22" r="2.5" fill="#C7D2FE" />
          <path d="M16 11.5v4M16 15.5l-6 4M16 15.5l6 4" stroke="#E0E7FF" strokeWidth="1.8" />
        </svg>
      );
    case "github-actions":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#1F2937" />
          <path d="M16 6c3 0 7 2 7 8 0 3-1 5-3 7l-4-4-4 4c-2-2-3-4-3-7 0-6 4-8 7-8z" fill="#3B82F6" />
          <circle cx="16" cy="13" r="2.5" fill="#FFFFFF" />
          <path d="M12 21l-3 4M20 21l3 4" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "superpowers":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#111111" />
          <circle cx="16" cy="16" r="10" stroke="#FFFFFF" strokeWidth="2" strokeDasharray="3 2" />
          <path d="M16 10v6l4 2" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
          <circle cx="16" cy="16" r="2" fill="#FFFFFF" />
        </svg>
      );
    case "datadog":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#632CA6" />
          <path d="M9 13c0-3 2-6 7-6s7 3 7 6c0 2-1 3.5-2 4.5l2 5.5h-3.5l-1-3h-5l-1 3H9l2-5.5C10 16.5 9 15 9 13z" fill="#FFFFFF" />
          <circle cx="13.5" cy="12" r="1.2" fill="#632CA6" />
          <circle cx="18.5" cy="12" r="1.2" fill="#632CA6" />
        </svg>
      );
    case "firecrawl":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFF7ED" stroke="#FED7AA" />
          <path d="M16 4c0 4.5-3 6.5-3 10 0 3.3 2.7 6 6 6s6-2.7 6-6c0-6-7-8-7-10z" fill="#EA580C" />
          <path d="M16 16c0 2-1.5 3-1.5 4.5 0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5c0-2.5-3-3.5-3-4.5z" fill="#F97316" />
        </svg>
      );
    case "parallel":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#111111" />
          <circle cx="16" cy="16" r="10" stroke="#FFFFFF" strokeWidth="1.5" fill="none" />
          <line x1="8" y1="12" x2="24" y2="12" stroke="#FFFFFF" strokeWidth="1.5" />
          <line x1="6" y1="16" x2="26" y2="16" stroke="#FFFFFF" strokeWidth="1.5" />
          <line x1="8" y1="20" x2="24" y2="20" stroke="#FFFFFF" strokeWidth="1.5" />
        </svg>
      );
    case "apify":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <path d="M16 6l9 16H7l9-16z" fill="#00A699" />
          <path d="M16 6l9 16-9-5V6z" fill="#FF5A5F" />
          <path d="M16 17l9 5H7l9-5z" fill="#FC642D" />
        </svg>
      );
    case "posthog":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FEF08A" />
          <path d="M7 16c0-4 4-8 9-8s9 4 9 8-4 8-9 8-9-4-9-8z" fill="#F97316" />
          <circle cx="13" cy="15" r="2" fill="#1E293B" />
          <circle cx="19" cy="15" r="2" fill="#1E293B" />
          <ellipse cx="16" cy="19" rx="2" ry="1.2" fill="#1E293B" />
          <path d="M10 9l-2-3M16 8V4M22 9l2-3" stroke="#F97316" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "granola":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#143424" />
          <path d="M16 7a9 9 0 1 0 9 9 6.5 6.5 0 1 0-6.5-6.5 4 4 0 1 0 4 4" stroke="#34D399" strokeWidth="2.2" strokeLinecap="round" fill="none" />
        </svg>
      );
    case "apollo":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FACC15" />
          <path d="M16 6v20M6 16h20M9 9l14 14M23 9L9 23" stroke="#000000" strokeWidth="3" strokeLinecap="round" />
        </svg>
      );
    case "google-docs":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <path d="M8 5h11l6 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="#4285F4" />
          <path d="M19 5l6 6h-6V5z" fill="#A1C2FA" />
          <rect x="10" y="14" width="12" height="1.8" rx="0.9" fill="#FFFFFF" />
          <rect x="10" y="18" width="12" height="1.8" rx="0.9" fill="#FFFFFF" />
          <rect x="10" y="22" width="7" height="1.8" rx="0.9" fill="#FFFFFF" />
        </svg>
      );
    case "google-sheets":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <path d="M8 5h11l6 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="#0F9D58" />
          <path d="M19 5l6 6h-6V5z" fill="#87CEAC" />
          <rect x="10" y="13" width="12" height="10" rx="1" fill="#FFFFFF" fillOpacity="0.2" stroke="#FFFFFF" strokeWidth="1.2" />
          <path d="M10 18h12M16 13v10" stroke="#FFFFFF" strokeWidth="1.2" />
        </svg>
      );
    case "google-slides":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <path d="M8 5h11l6 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="#F4B400" />
          <path d="M19 5l6 6h-6V5z" fill="#FCE293" />
          <rect x="11" y="14" width="10" height="8" rx="1" fill="#FFFFFF" />
        </svg>
      );
    case "google-calendar":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <rect x="6" y="8" width="20" height="17" rx="3" fill="#FFFFFF" stroke="#4285F4" strokeWidth="1.8" />
          <rect x="6" y="8" width="20" height="5.5" rx="1.5" fill="#4285F4" />
          <text x="16" y="21" textAnchor="middle" fontSize="8.5" fontWeight="bold" fill="#4285F4" fontFamily="sans-serif">31</text>
        </svg>
      );
    case "gmail":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <path d="M6 10v14a2 2 0 0 0 2 2h2v-9.5l6 4.5 6-4.5V26h2a2 2 0 0 0 2-2V10l-10 7.5L6 10z" fill="#EA4335" />
          <path d="M6 10l10 7.5V26H8a2 2 0 0 1-2-2V10z" fill="#4285F4" />
          <path d="M26 10l-10 7.5V26h8a2 2 0 0 0 2-2V10z" fill="#34A853" />
          <path d="M6 10l4 3v-5l-2-1.5A2 2 0 0 0 6 8v2z" fill="#C5221F" />
          <path d="M26 10l-4 3v-5l2-1.5a2 2 0 0 1 2 1.5v2z" fill="#FBBC04" />
        </svg>
      );
    case "onedrive":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FFFFFF" stroke="#E2E8F0" />
          <path d="M12 21h12a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0-5 6 4 4 0 0 0 4 4z" fill="#0078D4" />
        </svg>
      );
    case "email":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#E11D48" />
          <rect x="6" y="9" width="20" height="14" rx="2" fill="#FFFFFF" />
          <path d="M6 10l10 7 10-7" stroke="#E11D48" strokeWidth="1.8" fill="none" />
        </svg>
      );
    case "outlook":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0072C6" />
          <rect x="13" y="9" width="13" height="14" rx="2" fill="#FFFFFF" fillOpacity="0.3" />
          <path d="M13 11l6.5 5 6.5-5" stroke="#FFFFFF" strokeWidth="1.5" fill="none" />
          <rect x="6" y="8" width="13" height="16" rx="2.5" fill="#005A9E" />
          <circle cx="12.5" cy="16" r="4" stroke="#FFFFFF" strokeWidth="2" fill="none" />
        </svg>
      );
    case "x":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#000000" />
          <path d="M19.8 8h3.2l-7 8 8.2 10.9h-6.4l-5-6.6-5.8 6.6H3.8l7.5-8.6L3.4 8h6.6l4.6 6 5.2-6zm-1.1 17h1.8L9.2 9.8H7.3l11.4 15.2z" fill="#FFFFFF" />
        </svg>
      );
    case "canva":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#00C4CC" />
          <path d="M21 12c-2-2-5-2-7 0-3 3-3 8 0 11 2 2 5 2 7 0" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" fill="none" />
        </svg>
      );
    case "docs-canvas":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#334155" />
          <circle cx="10" cy="12" r="1.5" fill="#FFFFFF" />
          <line x1="14" y1="12" x2="23" y2="12" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="16" r="1.5" fill="#FFFFFF" />
          <line x1="14" y1="16" x2="23" y2="16" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="20" r="1.5" fill="#FFFFFF" />
          <line x1="14" y1="20" x2="23" y2="20" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "pr-review":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#1E293B" />
          <rect x="7" y="7" width="18" height="18" rx="2" stroke="#FFFFFF" strokeWidth="1.5" fill="none" />
          <path d="M11 13l2 2 4-4M11 19l2 2 4-4" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "mobbin":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#000000" />
          <path d="M7 23V9l5 7 5-7v14M17 23V9l4 6 4-6v14" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "1password":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0A85EA" />
          <circle cx="16" cy="16" r="9" stroke="#FFFFFF" strokeWidth="2" fill="none" />
          <path d="M16 11a3 3 0 0 0-1.5 5.6V19a1.5 1.5 0 0 0 3 0v-2.4A3 3 0 0 0 16 11z" fill="#FFFFFF" />
        </svg>
      );
    case "atlassian":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0052CC" />
          <path d="M15.5 15.5c-2.5 3-4 6.5-4 10.5h8c0-4-1.5-7.5-4-10.5z" fill="#FFFFFF" fillOpacity="0.6" />
          <path d="M16.5 6c-3 4.5-5 10-5 16h10c0-6-2-11.5-5-16z" fill="#FFFFFF" />
        </svg>
      );
    case "klaviyo":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#111111" />
          <rect x="7" y="10" width="18" height="12" rx="2" fill="#FFFFFF" />
          <path d="M12 10l5 12" stroke="#111111" strokeWidth="2" />
        </svg>
      );
    case "brevo":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#008060" />
          <circle cx="16" cy="16" r="9" stroke="#FFFFFF" strokeWidth="2" fill="none" />
          <text x="16" y="20.5" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#FFFFFF" fontFamily="sans-serif">B</text>
        </svg>
      );
    case "mailerlite":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#00A15D" />
          <rect x="6" y="10" width="20" height="12" rx="3" fill="#FFFFFF" />
          <text x="16" y="19" textAnchor="middle" fontSize="7.5" fontWeight="900" fill="#00A15D" fontFamily="sans-serif">lite</text>
        </svg>
      );
    case "bulkpublish":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#F97316" />
          <text x="16" y="21" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#FFFFFF" fontFamily="sans-serif">BP</text>
        </svg>
      );
    case "shopify":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#95BF47" />
          <path d="M20 9c0-2.2-1.8-4-4-4s-4 1.8-4 4h-3l2 17h14l2-17h-7zm-4-2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2z" fill="#5E8E3E" />
          <path d="M11 9l2 17h10l2-17h-14z" fill="#FFFFFF" />
          <text x="16" y="21" textAnchor="middle" fontSize="10" fontWeight="bold" fill="#5E8E3E" fontFamily="sans-serif">S</text>
        </svg>
      );
    case "kraken":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#5741D9" />
          <path d="M16 6c-5 0-8 3.5-8 8v9c0 1.5 1 2 2 1s2-2 2-2 1 2 2 2 2-1 2-2 1 2 2 2 2-1 2-2 1 2 2 2 2-.5 2-2v-9c0-4.5-3-8-8-8z" fill="#FFFFFF" />
          <circle cx="13" cy="14" r="1.5" fill="#5741D9" />
          <circle cx="19" cy="14" r="1.5" fill="#5741D9" />
        </svg>
      );
    case "phantom":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#8B5CF6" />
          <path d="M8 17c0-5 3.5-9 8-9s8 4 8 9c0 6-3 9-8 9s-8-3-8-9z" fill="#FFFFFF" />
          <circle cx="13.5" cy="16" r="1.8" fill="#8B5CF6" />
          <circle cx="18.5" cy="16" r="1.8" fill="#8B5CF6" />
        </svg>
      );
    case "ramp":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#FACC15" />
          <path d="M10 24c0-7.7 6.3-14 14-14v5c-5 0-9 4-9 9h-5z" fill="#111111" />
        </svg>
      );
    case "context.dev":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#2563EB" />
          <path d="M12 11l-4 5 4 5M20 11l4 5-4 5" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16" cy="16" r="2" fill="#93C5FD" />
        </svg>
      );
    case "ahrefs":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0066FF" />
          <rect x="8" y="18" width="3" height="7" rx="1" fill="#FFFFFF" />
          <rect x="13" y="13" width="3" height="12" rx="1" fill="#FFFFFF" />
          <rect x="18" y="9" width="3" height="16" rx="1" fill="#FFFFFF" />
          <rect x="23" y="15" width="3" height="10" rx="1" fill="#FFFFFF" />
        </svg>
      );
    case "treg":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#0F172A" />
          <circle cx="12" cy="12" r="2.5" fill="#FFFFFF" />
          <circle cx="20" cy="12" r="2.5" fill="#FFFFFF" />
          <circle cx="12" cy="20" r="2.5" fill="#FFFFFF" />
          <circle cx="20" cy="20" r="2.5" fill="#FFFFFF" />
        </svg>
      );
    case "higgsfield":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#A3E635" />
          <path d="M8 20c4-8 8 8 12 0s4-8 4-8" stroke="#1F2937" strokeWidth="3" strokeLinecap="round" fill="none" />
        </svg>
      );
    case "pstack":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#4F46E5" />
          <circle cx="16" cy="13" r="4.5" fill="#FDE047" />
          <path d="M9 25c0-4 3-6.5 7-6.5s7 2.5 7 6.5" fill="#FDE047" />
          <circle cx="14.5" cy="12.5" r="1" fill="#1E1B4B" />
          <circle cx="17.5" cy="12.5" r="1" fill="#1E1B4B" />
        </svg>
      );
    case "finance":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#059669" />
          <path d="M6 11l10-5 10 5v2H6v-2zm3 4h2v8H9v-8zm5 0h2v8h-2v-8zm5 0h2v8h-2v-8zm-14 9h20v2H5v-2z" fill="#FFFFFF" />
        </svg>
      );
    case "link":
      return (
        <svg viewBox="0 0 32 32" className="w-full h-full p-1.5" fill="none">
          <rect width="32" height="32" rx="8" fill="#10B981" />
          <path d="M13 10l6 6-6 6" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return null;
  }
}

export function normalizeBrand(id?: string, name?: string, command?: string, url?: string): string {
  const n = (name || "").toLowerCase();
  const i = (id || "").toLowerCase();
  const c = (command || "").toLowerCase();
  const u = (url || "").toLowerCase();

  // 1. Precise name & id checks FIRST
  if (n.includes("filesystem") || i.includes("filesystem") || c.includes("server-filesystem")) return "filesystem";
  if (n.includes("sequential") || i.includes("sequential") || c.includes("sequential-thinking")) return "sequential";
  if (n.includes("codebase memory") || i.includes("codebase-memory")) return "codebase-memory";
  if (n === "memory" || n.includes("memory mcp") || i.includes("memory") || c.includes("server-memory")) return "memory";
  if (n.includes("fetch") || i.includes("fetch") || c.includes("server-fetch")) return "fetch";
  if (n.includes("terminal") || i.includes("terminal") || n.includes("sandbox") || i.includes("sandbox")) return "terminal";
  if (n.includes("mineru") || i.includes("mineru")) return "mineru";
  if (n.includes("superpowers") || i.includes("superpowers")) return "superpowers";
  if (n.includes("firecrawl") || i.includes("firecrawl")) return "firecrawl";
  if (n.includes("posthog") || i.includes("posthog")) return "posthog";
  if (n.includes("apify") || i.includes("apify")) return "apify";
  if (n.includes("datadog") || i.includes("datadog")) return "datadog";
  if (n.includes("granola") || i.includes("granola")) return "granola";
  if (n.includes("apollo") || i.includes("apollo")) return "apollo";
  if (n.includes("parallel") || i.includes("parallel")) return "parallel";
  if (n.includes("bulkpublish") || i.includes("bulkpublish")) return "bulkpublish";
  if (n.includes("brevo") || i.includes("brevo")) return "brevo";
  if (n.includes("mailerlite") || i.includes("mailerlite")) return "mailerlite";
  if (n.includes("klaviyo") || i.includes("klaviyo")) return "klaviyo";
  if (n.includes("shopify") || i.includes("shopify")) return "shopify";
  if (n.includes("kraken") || i.includes("kraken")) return "kraken";
  if (n.includes("phantom") || i.includes("phantom")) return "phantom";
  if (n.includes("ramp") || i.includes("ramp")) return "ramp";
  if (n.includes("context.dev") || i.includes("context.dev") || n.includes("context-dev") || i.includes("context-dev")) return "context.dev";
  if (n.includes("ahrefs") || i.includes("ahrefs")) return "ahrefs";
  if (n.includes("treg") || i.includes("treg")) return "treg";
  if (n.includes("higgsfield") || i.includes("higgsfield")) return "higgsfield";
  if (n.includes("pstack") || i.includes("pstack")) return "pstack";
  if (n.includes("x money") || n.includes("finance") || i.includes("finance") || i.includes("x-money")) return "finance";
  if (n === "link" || i === "mcp-link") return "link";
  if (n === "x" || i === "mcp-x" || n.includes("twitter") || i.includes("twitter")) return "x";
  if (n.includes("docs canvas") || i.includes("docs-canvas")) return "docs-canvas";
  if (n.includes("pr review") || i.includes("pr-review")) return "pr-review";
  if (n.includes("google docs") || i.includes("google-docs")) return "google-docs";
  if (n.includes("google sheets") || i.includes("google-sheets")) return "google-sheets";
  if (n.includes("google slides") || i.includes("google-slides")) return "google-slides";
  if (n.includes("google calendar") || i.includes("google-calendar")) return "google-calendar";
  if (n.includes("gmail") || i.includes("gmail")) return "gmail";
  if (n.includes("outlook") || i.includes("outlook")) return "outlook";
  if (n === "email" || i === "mcp-email" || n.includes("email (imap")) return "email";
  if (n.includes("onedrive") || i.includes("onedrive")) return "onedrive";
  if (n.includes("mobbin") || i.includes("mobbin")) return "mobbin";
  if (n.includes("canva") || i.includes("canva")) return "canva";
  if (n.includes("1password") || i.includes("1password")) return "1password";
  if (n.includes("bitwarden") || i.includes("bitwarden")) return "bitwarden";
  if (n.includes("atlassian") || i.includes("atlassian") || n.includes("jira") || n.includes("confluence")) return "atlassian";
  if (n.includes("postgres") || i.includes("postgres") || c.includes("server-postgres")) return "postgres";
  if (n.includes("sqlite") || i.includes("sqlite") || c.includes("server-sqlite")) return "sqlite";
  if (n.includes("chrome") || i.includes("chrome") || c.includes("chrome-devtools")) return "chrome";
  if (n.includes("brave") || i.includes("brave") || c.includes("server-brave-search")) return "brave";
  if (n.includes("github actions") || i.includes("github-actions")) return "github-actions";
  if (n.includes("notion") || i.includes("notion")) return "notion";
  if (n.includes("linear") || i.includes("linear")) return "linear";
  if (n.includes("sentry") || i.includes("sentry")) return "sentry";
  if (n.includes("supabase") || i.includes("supabase")) return "supabase";
  if (n.includes("composio") || i.includes("composio")) return "composio";
  if (n.includes("slack") || i.includes("slack")) return "slack";
  if (n.includes("stripe") || i.includes("stripe")) return "stripe";
  if (n.includes("figma") || i.includes("figma")) return "figma";
  if (n.includes("vercel") || i.includes("vercel")) return "vercel";
  if (n.includes("cloudflare") || i.includes("cloudflare")) return "cloudflare";
  if (n.includes("postman") || i.includes("postman")) return "postman";
  if (n.includes("hugging") || i.includes("hugging")) return "huggingface";
  if (n.includes("playwright") || i.includes("playwright")) return "playwright";
  if (n.includes("puppeteer") || i.includes("puppeteer")) return "puppeteer";
  if (n.includes("docker") || i.includes("docker")) return "docker";
  if (n.includes("redis") || i.includes("redis")) return "redis";
  if (n.includes("mongo") || i.includes("mongo")) return "mongodb";
  if (n.includes("qdrant") || i.includes("qdrant")) return "qdrant";
  if (n.includes("pinecone") || i.includes("pinecone")) return "pinecone";
  if (n.includes("weaviate") || i.includes("weaviate")) return "weaviate";
  if (n.includes("exa") || i.includes("exa")) return "exa";
  if (n.includes("perplexity") || i.includes("perplexity")) return "perplexity";
  if (n.includes("cursor") || i.includes("cursor")) return "cursor";
  if (n.includes("vscode") || i.includes("vscode")) return "vscode";
  if (n.includes("gravitas") || i.includes("gravitas")) return "gravitas";
  if (n.includes("openapi") || i.includes("openapi")) return "openapi";
  if (n.includes("security") || i.includes("security")) return "security";
  if (n.includes("modern-web") || i.includes("modern-web")) return "chrome";

  // Match "github" ONLY if name or id explicitly refers to GitHub itself!
  if (n.includes("github") || (i.includes("github") && !i.includes("actions"))) return "github";

  // URL matching (excluding git hostings)
  if (u && !u.includes("github.com") && !u.includes("gitlab.com")) {
    if (u.includes("notion.so") || u.includes("notion.com")) return "notion";
    if (u.includes("linear.app")) return "linear";
    if (u.includes("sentry.io") || u.includes("sentry.dev")) return "sentry";
    if (u.includes("supabase.com")) return "supabase";
    if (u.includes("slack.com")) return "slack";
    if (u.includes("stripe.com")) return "stripe";
    if (u.includes("postman.com")) return "postman";
    if (u.includes("datadoghq.com")) return "datadog";
    if (u.includes("firecrawl.dev")) return "firecrawl";
    if (u.includes("posthog.com")) return "posthog";
    if (u.includes("apify.com")) return "apify";
    if (u.includes("apollo.io")) return "apollo";
    if (u.includes("granola.ai")) return "granola";
  }

  return "";
}

export function extractDomain(urlOrName?: string): string {
  if (!urlOrName) return "";
  const cleaned = urlOrName.trim();
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    try {
      const u = new URL(cleaned);
      const host = u.hostname.toLowerCase();
      // Generic git hosting is not the service brand
      if (host === "github.com" || host === "www.github.com" || host === "gitlab.com") {
        return "";
      }
      // Remove mcp. or api. or connect. or docs. subdomain if present
      return host.replace(/^(mcp|api|connect|docs|dashboard|cdn)\./, "");
    } catch {}
  }

  // Handle local executable paths e.g. C:\Program Files\Notion\Notion.exe or /usr/bin/docker
  if (cleaned.includes("/") || cleaned.includes("\\") || cleaned.toLowerCase().endsWith(".exe")) {
    const filename = cleaned.split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase() || "";
    if (filename) {
      if (BRAND_DOMAINS[filename]) return BRAND_DOMAINS[filename];
      const matchKey = Object.keys(BRAND_DOMAINS).find((k) => filename.includes(k));
      if (matchKey) return BRAND_DOMAINS[matchKey];
    }
  }

  // Handle CLI package commands e.g. npx -y @modelcontextprotocol/server-postgres or docker run
  if (cleaned.startsWith("npx") || cleaned.startsWith("node") || cleaned.startsWith("python") || cleaned.startsWith("docker")) {
    const pkgMatch = /@?[a-zA-Z0-9_-]+\/(?:server-)?([a-zA-Z0-9_-]+)/.exec(cleaned);
    if (pkgMatch && pkgMatch[1]) {
      const pkgName = pkgMatch[1].toLowerCase().replace(/^server-/, "");
      if (BRAND_DOMAINS[pkgName]) return BRAND_DOMAINS[pkgName];
      const matchKey = Object.keys(BRAND_DOMAINS).find((k) => pkgName.includes(k));
      if (matchKey) return BRAND_DOMAINS[matchKey];
    }
  }

  // Handle GitHub author/repo e.g. "microsoft/playwright" or "razorpay/razorpay-mcp"
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned)) {
    const repoPart = cleaned.split("/")[1].toLowerCase().replace(/-(?:mcp|server|plugin)$/, "");
    if (BRAND_DOMAINS[repoPart]) return BRAND_DOMAINS[repoPart];
    const matchKey = Object.keys(BRAND_DOMAINS).find((k) => repoPart.includes(k));
    if (matchKey) return BRAND_DOMAINS[matchKey];
  }

  // Check if string contains a domain like xxx.com, xxx.app, xxx.io
  const domainMatch = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})(?:\/.*)?/i.exec(cleaned);
  if (domainMatch) return domainMatch[1].toLowerCase();

  // Check brand dictionary exact match
  const key = cleaned.toLowerCase();
  if (BRAND_DOMAINS[key]) return BRAND_DOMAINS[key];

  // Check brand dictionary substring match
  const brandSub = Object.keys(BRAND_DOMAINS).find((k) => key.includes(k));
  if (brandSub) return BRAND_DOMAINS[brandSub];

  return "";
}

function lettersFor(name: string, mark?: string) {
  return (
    (mark ?? "").trim() ||
    Array.from(name.replace(/[^A-Za-z0-9]/g, ""))
      .slice(0, 2)
      .join("")
      .toUpperCase() ||
    "MC"
  );
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

export function getFaviconSources(urlOrDomain: string): string[] {
  const domain = extractDomain(urlOrDomain);
  if (!domain) return [];
  return [
    `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
    `https://${domain}/favicon.ico`,
    `https://${domain}/apple-touch-icon.png`,
  ];
}

export function AppLogo({
  id,
  name,
  mark,
  url,
  command,
  size = 32,
  className = "",
}: {
  id?: string;
  name?: string;
  mark?: string;
  url?: string;
  command?: string;
  size?: number;
  className?: string;
}) {
  const safeName = name || id || "App";
  const brandKey = normalizeBrand(id, name, command, url);
  const logo = brandKey ? LOGOS[brandKey] : undefined;

  // Domain & Remote icon sources
  const domain =
    extractDomain(url) ||
    extractDomain(command) ||
    BRAND_DOMAINS[safeName.toLowerCase()] ||
    extractDomain(safeName) ||
    (brandKey ? BRAND_DOMAINS[brandKey] : "");

  const remoteSources = useMemo(() => {
    return getFaviconSources(domain || url || command || safeName);
  }, [domain, url, command, safeName]);

  const [srcIndex, setSrcIndex] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setSrcIndex(0);
    setImgFailed(false);
  }, [domain, url, command, safeName]);

  // If local/system tool
  const lowerName = safeName.toLowerCase();
  const lowerCmd = (command || "").toLowerCase();
  const lowerId = (id || "").toLowerCase();

  const isFs = lowerName.includes("filesystem") || lowerCmd.includes("filesystem") || lowerId.includes("filesystem");
  const isMem = lowerName === "memory" || lowerCmd.includes("memory") || lowerId.includes("memory");
  const isSeq = lowerName.includes("sequential") || lowerCmd.includes("sequential");
  const isGit = lowerName === "git" || lowerCmd.includes("git") || lowerId.includes("git");
  const isTime = lowerName === "time" || lowerCmd.includes("time") || lowerId.includes("time");
  const isSkillPack = lowerName.includes("prebuilt") || lowerId.includes("prebuilt");
  const isDb =
    lowerName.includes("database") ||
    lowerCmd.includes("database") ||
    lowerId.includes("database") ||
    lowerName.includes("sqlite") ||
    lowerCmd.includes("sqlite") ||
    lowerName.includes("redis") ||
    lowerCmd.includes("redis") ||
    lowerName.includes("mysql") ||
    lowerName.includes("mongo");
  const isTerminal =
    lowerName.includes("terminal") ||
    lowerCmd.includes("terminal") ||
    lowerId.includes("terminal") ||
    lowerName.includes("sandbox") ||
    lowerCmd.includes("sandbox") ||
    lowerName.includes("shell") ||
    lowerCmd.includes("shell");
  const isSecurity =
    lowerName.includes("security") ||
    lowerId.includes("security") ||
    lowerName.includes("vulnerability") ||
    lowerName.includes("audit") ||
    lowerName.includes("vault") ||
    lowerId.includes("vault");
  const isGravitas = lowerName.includes("gravitas") || lowerId.includes("gravitas");
  const isSearch =
    lowerName.includes("search") ||
    lowerCmd.includes("search") ||
    lowerName.includes("fetch") ||
    lowerCmd.includes("fetch") ||
    lowerName.includes("browse") ||
    lowerCmd.includes("browse");

  const containerStyle = {
    width: size,
    height: size,
    borderRadius: Math.max(6, Math.round(size * 0.25)),
  };

  // 0. High-fidelity Authentic Vector Brand SVGs
  const customSvg = brandKey ? getBrandCustomSvg(brandKey) : null;
  if (customSvg) {
    return (
      <span
        className={`mark logo shrink-0 inline-flex items-center justify-center overflow-hidden select-none border border-black/5 shadow-2xs ${className}`}
        style={containerStyle}
        title={safeName}
      >
        {customSvg}
      </span>
    );
  }

  // 1. Built-in Vector Logo
  if (logo) {
    const fill = brandKey === "gemini" ? "url(#ronic-gemini)" : logo.fg;
    return (
      <span
        className="mark logo shrink-0 inline-flex items-center justify-center border border-black/5 shadow-2xs overflow-hidden"
        style={{ ...containerStyle, background: logo.bg }}
        title={safeName}
      >
        <svg viewBox={logo.viewBox} fillRule="evenodd" aria-hidden="true" style={{ width: "100%", height: "100%" }}>
          {brandKey === "gemini" && (
            <defs>
              <linearGradient id="ronic-gemini" x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#1A73E8" />
                <stop offset="0.45" stopColor="#9B72CB" />
                <stop offset="1" stopColor="#D96570" />
              </linearGradient>
            </defs>
          )}
          {logo.paths.map((d, i) => (
            <path key={i} d={d} fill={fill} fillRule="evenodd" />
          ))}
        </svg>
      </span>
    );
  }

  // 2. System / MCP tool icons
  if (isFs) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-amber-50 text-amber-700 border border-amber-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Folder size={size * 0.75} />
      </span>
    );
  }
  if (isMem) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-purple-50 text-purple-700 border border-purple-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Brain size={size * 0.75} />
      </span>
    );
  }
  if (isSeq) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Sparkles size={size * 0.75} />
      </span>
    );
  }
  if (isGit) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-rose-50 text-rose-700 border border-rose-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <GitBranch size={size * 0.75} />
      </span>
    );
  }
  if (isTime) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-cyan-50 text-cyan-700 border border-cyan-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Clock size={size * 0.75} />
      </span>
    );
  }
  if (isSkillPack) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-slate-100 text-slate-700 border border-slate-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Layers size={size * 0.75} />
      </span>
    );
  }

  // 3. Dynamic Website / Favicon resolver
  if (remoteSources.length > 0 && !imgFailed && srcIndex < remoteSources.length) {
    return (
      <span
        className="mark logo site shrink-0 inline-flex items-center justify-center bg-white border border-slate-200 shadow-2xs overflow-hidden"
        style={containerStyle}
        title={safeName}
      >
        <img
          src={remoteSources[srcIndex]}
          alt={safeName}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          onError={() => {
            if (srcIndex + 1 < remoteSources.length) {
              setSrcIndex((prev) => prev + 1);
            } else {
              setImgFailed(true);
            }
          }}
        />
      </span>
    );
  }

  // 4. Extended Tool Category Fallbacks
  if (isDb) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Database size={size * 0.75} />
      </span>
    );
  }
  if (isTerminal) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-slate-900 text-emerald-400 border border-slate-700 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Terminal size={size * 0.75} />
      </span>
    );
  }
  if (isGravitas) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-emerald-50 text-emerald-700 border border-emerald-300 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <ShieldCheck size={size * 0.75} />
      </span>
    );
  }
  if (isSecurity) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-rose-50 text-rose-700 border border-rose-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Lock size={size * 0.75} />
      </span>
    );
  }
  if (isSearch) {
    return (
      <span
        className="mark shrink-0 inline-flex items-center justify-center bg-sky-50 text-sky-700 border border-sky-200 shadow-2xs"
        style={containerStyle}
        title={safeName}
      >
        <Globe size={size * 0.75} />
      </span>
    );
  }

  // 5. Elegant Brand Monogram Badge
  const letters = lettersFor(safeName, mark);
  const bgColor = stringToColor(safeName);

  return (
    <span
      className="mark shrink-0 inline-flex items-center justify-center text-white font-bold text-xs shadow-2xs border border-white/20 select-none"
      style={{
        ...containerStyle,
        backgroundColor: bgColor,
        fontSize: Math.max(10, Math.round(size * 0.36)),
        color: "#ffffff",
      }}
      title={safeName}
    >
      <span style={{ color: "#ffffff" }}>{letters}</span>
    </span>
  );
}
