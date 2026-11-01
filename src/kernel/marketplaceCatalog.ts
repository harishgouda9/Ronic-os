import type { Snapshot } from "../types";

export type MarketplaceCategory =
  | "Recommended for you"
  | "Code"
  | "Data"
  | "Sales & Marketing"
  | "Communication"
  | "Design"
  | "Productivity"
  | "Password Managers"
  | "Finance"
  | "Research"
  | "Supercharge & Bots"
  | "Code & Reverse Engineering"
  | "Quant & FinTech"
  | string;

export type AuthMethodType =
  | "oauth"        // Browser OAuth 2.0 (Google, GitHub, Slack, Linear, Notion, Microsoft, Canva, X, etc.)
  | "api_key"      // Single API Key / Secret Token (Perplexity, Firecrawl, Exa, Pinecone, etc.)
  | "multi_field"  // Structured credentials (Shopify, Supabase, Datadog, Razorpay, SMTP/Email, etc.)
  | "local_daemon" // Local service / daemon check (Docker Desktop)
  | "local_path"   // Local directory selection (Filesystem MCP)
  | "none";        // Public / zero-auth built-in utility

export interface AuthFieldConfig {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "select";
  placeholder: string;
  description?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
}

export interface AuthConfig {
  method: AuthMethodType;
  providerName?: string;
  oauthUrl?: string;
  scopes?: string[];
  fields?: AuthFieldConfig[];
  keyLabel?: string;
  keyPlaceholder?: string;
  keyUrl?: string;
  helpText?: string;
  daemonCheckCmd?: string;
  daemonName?: string;
}

export interface AdvancedAuthConfig {
  clientId?: string;
  clientSecret?: string;
  customScopes?: string[];
  redirectUri?: string;
  serviceAccountJson?: string;
  endpointUrl?: string;
  customHeaders?: Record<string, string>;
  envVars?: Record<string, string>;
}

export interface McpAuthRecord {
  id: string;
  authMethod: AuthMethodType;
  authenticatedAt: number;
  accountIdentity?: string; // e.g. "alex@company.com" or "acme-store.myshopify.com"
  credentialMask?: string;  // e.g. "sk-...78a9"
  config?: Record<string, string>; // Multi-field values
  advanced?: AdvancedAuthConfig; // Optional advanced authentication parameters
  /** True only after a provider or local check succeeded. A typed form alone is not enough. */
  verified?: boolean;
}

export interface MarketplaceCatalogItem {
  id: string;
  slug: string;
  name: string;
  kind: "mcp" | "plugin" | "skill";
  tabSource: "included" | "store";
  category: MarketplaceCategory;
  recommended?: boolean;
  websiteUrl?: string;
  description: string;
  authorOrRepo: string;
  verified: boolean;
  requiresKey?: boolean;
  keyLabel?: string;
  keyUrl?: string;
  requiresAuth?: boolean;
  authConfig?: AuthConfig;
  mcpConfig?: {
    transport: "stdio" | "sse";
    command: string;
    args: string[];
    url: string;
    tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  };
  pluginConfig?: {
    version: string;
    hasAgent: boolean;
    hasDesktop: boolean;
    tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
    hooks: string[];
    skills: string[];
    desktop: { kind: string; label: string; icon: string; target: string }[];
  };
  skillConfig?: {
    title: string;
    description: string;
    slashCommand: string;
    requiresTools: string[];
    platforms: string[];
    body: string;
  };
}

export const MARKETPLACE_CATALOG: MarketplaceCatalogItem[] = [
  // ----------------------------------------------------
  // INCLUDED TAB ITEMS
  // ----------------------------------------------------
  {
    id: "mcp-notion",
    slug: "notion-mcp",
    name: "Notion",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    description:
      "Notion's remote MCP server for querying workspace databases, finding documentation, and appending page blocks. Enter your Notion integration token to authenticate.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Notion Workspace",
          oauthUrl: "https://api.notion.com/v1/oauth/authorize",
          keyLabel: "Notion Internal Integration Secret (secret_...)",
          keyPlaceholder: "secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://www.notion.so/my-integrations",
          helpText: "Connect with Notion OAuth or enter your private Notion integration token."
    },
    authorOrRepo: "notion-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Notion Integration Secret (secret_...)",
    keyUrl: "https://www.notion.so/my-integrations",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.notion.com/mcp",
      tools: [
        { name: "query_database", description: "Search pages and databases in Notion", inputSchema: { type: "object" } },
        { name: "append_block_children", description: "Append blocks to Notion page", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-linear",
    slug: "linear-mcp",
    name: "Linear",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    description:
      "Linear's remote MCP server for issues, cycles, and roadmaps. Enter your Linear personal API key to query tickets and assign bug remediations.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Linear",
          oauthUrl: "https://linear.app/oauth/authorize",
          keyLabel: "Linear Personal API Key (lin_api_...)",
          keyPlaceholder: "lin_api_xxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://linear.app/settings/api",
          helpText: "Connect with Linear OAuth or enter your personal API key."
    },
    authorOrRepo: "linear-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Linear Personal API Key (lin_api_...)",
    keyUrl: "https://linear.app/settings/api",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.linear.app/mcp",
      tools: [
        { name: "list_issues", description: "List and filter Linear issues", inputSchema: { type: "object" } },
        { name: "create_issue", description: "Create a new issue in Linear", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-sentry",
    slug: "sentry-mcp",
    name: "Sentry",
    kind: "mcp",
    tabSource: "included",
    category: "Code & Reverse Engineering",
    description:
      "Sentry's remote MCP server for production stacktraces, issues, and release health. Enter your Sentry user auth token to authorize error queries.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Sentry",
          keyUrl: "https://sentry.io/settings/account/api/auth-tokens/",
          helpText: "Connect Sentry to inspect crash reports, stack traces, and automated remediation tickets.",
          fields: [
                {
                      key: "authToken",
                      label: "Sentry Auth Token",
                      type: "password",
                      placeholder: "sntrys_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                },
                {
                      key: "orgSlug",
                      label: "Organization Slug",
                      type: "text",
                      placeholder: "acme-corp",
                      required: true
                }
          ]
    },
    authorOrRepo: "sentry-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Sentry User Auth Token (sntrys_...)",
    keyUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.sentry.dev/mcp",
      tools: [
        { name: "fetch_errors", description: "Fetch latest production errors and stacktraces", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-supabase",
    slug: "supabase-mcp",
    name: "Supabase",
    kind: "mcp",
    tabSource: "included",
    category: "Code & Reverse Engineering",
    description:
      "Supabase MCP server for Postgres schema inspection, migrations, and edge functions. Enter your Supabase project API key or service role key.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Supabase",
          keyUrl: "https://app.supabase.com/project/_/settings/api",
          helpText: "Connect your Supabase project for instant database queries, vector embeddings, and auth policies.",
          fields: [
                {
                      key: "projectUrl",
                      label: "Project URL",
                      type: "url",
                      placeholder: "https://your-project-id.supabase.co",
                      required: true
                },
                {
                      key: "serviceKey",
                      label: "Service Role or Anon API Key",
                      type: "password",
                      placeholder: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                      required: true
                }
          ]
    },
    authorOrRepo: "supabase-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Supabase Project API Key (anon / service_role)",
    keyUrl: "https://supabase.com/dashboard/project/_/settings/api",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.supabase.com/mcp",
      tools: [
        { name: "inspect_schema", description: "Inspect database tables, columns, and foreign keys", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "composio-skill",
    slug: "composio",
    name: "Composio",
    kind: "skill",
    tabSource: "included",
    category: "Productivity",
    description:
      "Writes a Composio skill file onto the selected bot. It does not call Composio until that bot is connected to Composio.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          providerName: "Composio",
          keyLabel: "Composio API Key (ck_... or Personal Key)",
          keyPlaceholder: "ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://app.composio.dev/settings",
          helpText: "Enter your Composio API key to let your agents trigger actions across 100+ connected apps."
    },
    authorOrRepo: "ComposioHQ/composio",
    verified: true,
    skillConfig: {
      title: "Composio Skill",
      description: "Notes how this bot should use Composio once the server is connected",
      slashCommand: "/composio",
      requiresTools: [],
      platforms: ["windows", "macos", "linux"],
      body: "---\nname: composio\ndescription: Notes how this bot should use Composio once the server is connected\nslash_command: /composio\nrequires_tools: []\nplatforms: [windows, macos, linux]\n---\n\n# Composio\n\nThis file is saved on the selected bot. Connecting the Composio MCP server stores its address and key on this computer. Chat does not call that remote server yet.\n",
    },
  },
  {
    id: "mcp-composio",
    slug: "composio-mcp",
    name: "Composio MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    description:
      "Composio MCP at connect.composio.dev/mcp. Stores consumer key (ck_...) securely in OS Keychain Vault for agent tool authorization.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          providerName: "Composio MCP",
          keyLabel: "Composio API Key (ck_...)",
          keyPlaceholder: "ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://app.composio.dev/settings",
          helpText: "Enter your Composio API key to expose live tool execution schemas to your agents."
    },
    authorOrRepo: "ComposioHQ",
    verified: true,
    requiresKey: true,
    keyLabel: "Composio Consumer Key (ck_...)",
    keyUrl: "https://dashboard.composio.dev",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://connect.composio.dev/mcp",
      tools: [
        { name: "execute_action", description: "Execute an action on connected Composio services", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-github",
    slug: "github-mcp",
    name: "GitHub MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Code & Reverse Engineering",
    description:
      "GitHub MCP server for PR automation, code search, issue management, and git review routines with personal access token authentication.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "GitHub",
          oauthUrl: "https://github.com/login/oauth/authorize",
          scopes: [
                "repo",
                "read:user",
                "workflow"
          ],
          keyLabel: "GitHub Personal Access Token (ghp_... or github_pat_...)",
          keyPlaceholder: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://github.com/settings/tokens",
          helpText: "Authorize via GitHub OAuth or provide a Personal Access Token with repo scope."
    },
    authorOrRepo: "github/github-mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "GitHub Personal Access Token (ghp_...)",
    keyUrl: "https://github.com/settings/tokens",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://api.githubcopilot.com/mcp/",
      tools: [
        { name: "search_repositories", description: "Search code and repos across GitHub", inputSchema: { type: "object" } },
        { name: "create_pull_request", description: "Create a PR from branch diff", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-slack",
    slug: "slack-mcp",
    name: "Slack MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    description:
      "Slack integration to dispatch bot updates, monitor channels, and post automated daily team summaries directly to Slack threads.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Slack Workspace",
          oauthUrl: "https://slack.com/oauth/v2/authorize",
          keyLabel: "Slack Bot/User Token (xoxb-... or xoxp-...)",
          keyPlaceholder: "xoxb-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://api.slack.com/apps",
          helpText: "Install to your Slack workspace via OAuth or provide an xoxb/xoxp token."
    },
    authorOrRepo: "slack-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Slack Bot Token (xoxb-...)",
    keyUrl: "https://api.slack.com/apps",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      url: "",
      tools: [
        { name: "post_message", description: "Post message to channel or thread", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-filesystem",
    slug: "filesystem-mcp",
    name: "Filesystem MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Code & Reverse Engineering",
    description:
      "Official local filesystem MCP server. Provides secure directory navigation, read/write primitives, and file metadata analysis.",
    requiresAuth: false,
    authConfig: {
          method: "local_path",
          providerName: "Local Project Filesystem",
          helpText: "Grants sandboxed read/write access to your active workspace directory."
    },
    authorOrRepo: "modelcontextprotocol/filesystem",
    verified: true,
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      url: "",
      tools: [
        { name: "read_file", description: "Read contents of a local file", inputSchema: { type: "object" } },
        { name: "write_file", description: "Write contents to a local file", inputSchema: { type: "object" } },
        { name: "list_directory", description: "List files in a directory", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-memory",
    slug: "memory-mcp",
    name: "Memory MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Supercharge & Bots",
    description:
      "Official local graph memory MCP server. Preserves relational entities, key decisions, and session facts in local knowledge graphs.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "Local embedded vector memory and semantic associative search engine. Zero configuration required."
    },
    authorOrRepo: "modelcontextprotocol/memory",
    verified: true,
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      url: "",
      tools: [
        { name: "create_entities", description: "Store entities in relational memory graph", inputSchema: { type: "object" } },
        { name: "search_nodes", description: "Query knowledge nodes by semantic relation", inputSchema: { type: "object" } },
      ],
    },
  },

  {
    id: "mcp-playwright",
    slug: "playwright-cdp",
    name: "Playwright MCP",
    kind: "mcp",
    tabSource: "store",
    category: "Code & Reverse Engineering",
    description:
      "Playwright MCP server. Add records `npx @playwright/mcp` locally. The server starts when a bot runs that command.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "Local headless Chromium browser automation runtime. Zero configuration required."
    },
    authorOrRepo: "microsoft/playwright",
    verified: true,
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      url: "",
      tools: [
        { name: "browser_navigate", description: "Navigate browser to URL", inputSchema: { type: "object" } },
        { name: "browser_snapshot", description: "Extract DOM accessibility tree", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-razorpay",
    slug: "razorpay-upi",
    name: "Razorpay MCP",
    kind: "mcp",
    tabSource: "store",
    category: "Quant & FinTech",
    description:
      "Razorpay MCP server. Add stores the key locally and records `npx @razorpay/mcp-server`. It does not move money by itself.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Razorpay",
          keyUrl: "https://dashboard.razorpay.com/app/keys",
          helpText: "Connect Razorpay for automated UPI payouts, payment links, and invoice status checking.",
          fields: [
                {
                      key: "keyId",
                      label: "Key ID",
                      type: "text",
                      placeholder: "rzp_test_... or rzp_live_...",
                      required: true
                },
                {
                      key: "keySecret",
                      label: "Key Secret",
                      type: "password",
                      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                }
          ]
    },
    authorOrRepo: "razorpay/razorpay-mcp",
    verified: false,
    requiresKey: true,
    keyLabel: "Razorpay API Key Secret (rzp_...)",
    keyUrl: "https://dashboard.razorpay.com/#/app/keys",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@razorpay/mcp-server"],
      url: "",
      tools: [
        { name: "create_payment_link", description: "Generate guarded UPI payment link", inputSchema: { type: "object" } },
        { name: "verify_payment", description: "Verify transaction confirmation signature", inputSchema: { type: "object" } },
      ],
    },
  },

  // ----------------------------------------------------
  // TRENDING & TOP MCP SERVERS (Apps & Skills)
  // ----------------------------------------------------
  {
    id: "mcp-datadog",
    slug: "datadog-mcp",
    name: "Datadog",
    kind: "mcp",
    tabSource: "included",
    category: "Code",
    recommended: true,
    description: "Datadog remote MCP server for APM tracing, infrastructure metrics, dashboard monitors, and live log stream inspection.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Datadog",
          keyUrl: "https://app.datadoghq.com/organization-settings/api-keys",
          helpText: "Connect Datadog metrics, APM traces, and log monitoring pipelines.",
          fields: [
                {
                      key: "apiKey",
                      label: "Datadog API Key",
                      type: "password",
                      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                },
                {
                      key: "appKey",
                      label: "Datadog Application Key",
                      type: "password",
                      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                },
                {
                      key: "site",
                      label: "Datadog Site Region",
                      type: "select",
                      placeholder: "datadoghq.com",
                      options: [
                            {
                                  value: "datadoghq.com",
                                  label: "US1 (datadoghq.com)"
                            },
                            {
                                  value: "us3.datadoghq.com",
                                  label: "US3 (us3.datadoghq.com)"
                            },
                            {
                                  value: "us5.datadoghq.com",
                                  label: "US5 (us5.datadoghq.com)"
                            },
                            {
                                  value: "datadoghq.eu",
                                  label: "EU (datadoghq.eu)"
                            },
                            {
                                  value: "ap1.datadoghq.com",
                                  label: "AP1 (ap1.datadoghq.com)"
                            }
                      ],
                      defaultValue: "datadoghq.com",
                      required: true
                }
          ]
    },
    authorOrRepo: "datadog-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Datadog API Key & Application Key",
    keyUrl: "https://app.datadoghq.com/organization-settings/api-keys",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.datadoghq.com/mcp",
      tools: [
        { name: "query_metrics", description: "Query Datadog infrastructure and APM metrics", inputSchema: { type: "object" } },
        { name: "fetch_traces", description: "Fetch distributed traces and latency flame graphs", inputSchema: { type: "object" } },
        { name: "search_logs", description: "Search structured log events with facet filters", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-superpowers",
    slug: "superpowers-mcp",
    name: "Superpowers",
    kind: "mcp",
    tabSource: "included",
    category: "Code",
    recommended: true,
    description: "Autonomous execution MCP server providing secure shell invocation, process monitoring, and desktop tool automation.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "Built-in autonomous agent collaboration and blackboard protocol suite. Zero configuration required."
    },
    authorOrRepo: "superpowers-ai/superpowers",
    verified: true,
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "superpowers-mcp"],
      url: "",
      tools: [
        { name: "exec_process", description: "Execute shell commands with timeout guards", inputSchema: { type: "object" } },
        { name: "inspect_runtime", description: "Inspect system memory and active background processes", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-firecrawl",
    slug: "firecrawl-mcp",
    name: "Firecrawl",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: true,
    description: "Clean web scraping, deep recursive crawler, and markdown extraction MCP engine for LLMs.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Firecrawl API Key (fc-...)",
          keyPlaceholder: "fc-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://www.firecrawl.dev/app/api-keys",
          helpText: "Turn entire websites into clean LLM-ready markdown with Firecrawl web scraper."
    },
    authorOrRepo: "mendableai/firecrawl-mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "Firecrawl API Key (fc-...)",
    keyUrl: "https://firecrawl.dev",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      url: "",
      tools: [
        { name: "scrape_url", description: "Scrape single URL into clean structured markdown", inputSchema: { type: "object" } },
        { name: "crawl_domain", description: "Recursively crawl domain with path depth limits", inputSchema: { type: "object" } },
        { name: "search_extract", description: "Search web and extract clean text without ads or navbars", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-posthog",
    slug: "posthog-mcp",
    name: "PostHog",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: true,
    description: "PostHog product analytics, user funnel analysis, feature flags, and session replay query MCP server.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "PostHog",
          keyUrl: "https://us.posthog.com/settings/user-api-keys",
          helpText: "Query product analytics, funnel dropoffs, and session trends directly from PostHog.",
          fields: [
                {
                      key: "apiKey",
                      label: "Personal API Key",
                      type: "password",
                      placeholder: "phx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                },
                {
                      key: "host",
                      label: "PostHog Host URL",
                      type: "text",
                      placeholder: "https://us.i.posthog.com",
                      defaultValue: "https://us.i.posthog.com",
                      required: true
                }
          ]
    },
    authorOrRepo: "posthog-official",
    verified: true,
    requiresKey: true,
    keyLabel: "PostHog Personal API Key",
    keyUrl: "https://us.posthog.com/settings/user-api-keys",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.posthog.com/mcp",
      tools: [
        { name: "query_funnel", description: "Query conversion funnels and user dropoff rates", inputSchema: { type: "object" } },
        { name: "check_feature_flag", description: "Inspect feature flags and rollout percentages", inputSchema: { type: "object" } },
        { name: "search_events", description: "Query custom events and user interaction paths", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-apify",
    slug: "apify-mcp",
    name: "Apify",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: true,
    description: "Apify cloud actors MCP server. Run web scrapers, social media monitors, and structured web dataset extractions.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Apify Personal API Token (apify_api_...)",
          keyPlaceholder: "apify_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://console.apify.com/account/integrations",
          helpText: "Run hundreds of ready-made web scrapers for Google Maps, Amazon, Twitter, and LinkedIn."
    },
    authorOrRepo: "apify-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Apify API Token (apify_api_...)",
    keyUrl: "https://console.apify.com/account/integrations",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.apify.com/mcp",
      tools: [
        { name: "run_actor", description: "Trigger an Apify scraping or crawling Actor task", inputSchema: { type: "object" } },
        { name: "fetch_dataset", description: "Fetch structured dataset records output by actors", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-parallel",
    slug: "parallel-mcp",
    name: "Parallel",
    kind: "mcp",
    tabSource: "included",
    category: "Research",
    recommended: true,
    description: "Deep web synthesis and parallel agentic research engine. Coordinates distributed web search and multi-source synthesis.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Parallel API Token",
          keyPlaceholder: "par_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://parallel.fi",
          helpText: "Parallel high-throughput LLM workflow execution engine."
    },
    authorOrRepo: "parallel-ai",
    verified: true,
    requiresKey: true,
    keyLabel: "Parallel API Key",
    keyUrl: "https://parallel.ai",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.parallel.ai/mcp",
      tools: [
        { name: "parallel_research", description: "Run multi-threaded deep web research across hundreds of sources", inputSchema: { type: "object" } },
        { name: "synthesize_findings", description: "Synthesize consensus findings and contradictory claims", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-granola",
    slug: "granola-mcp",
    name: "Granola",
    kind: "mcp",
    tabSource: "included",
    category: "Sales & Marketing",
    recommended: true,
    description: "AI meeting recorder and transcript intelligence. Converts client conversations into structured action items and CRM notes.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Granola API Access Key",
          keyPlaceholder: "grn_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://www.granola.ai",
          helpText: "AI meeting note taker for transcribing calls, identifying action items, and syncing back to CRM."
    },
    authorOrRepo: "granola-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Granola Access Token",
    keyUrl: "https://granola.ai",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.granola.ai/mcp",
      tools: [
        { name: "fetch_meeting_notes", description: "Fetch AI structured meeting notes and action items", inputSchema: { type: "object" } },
        { name: "search_transcripts", description: "Search verbatim audio transcripts by semantic keyword", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-apollo",
    slug: "apollo-mcp",
    name: "Apollo.io",
    kind: "mcp",
    tabSource: "included",
    category: "Sales & Marketing",
    recommended: true,
    description: "B2B sales database, prospect email enrichment, company signals, and outreach sequence execution MCP server.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Apollo.io Master API Key",
          keyPlaceholder: "xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://app.apollo.io/#/settings/integrations/api",
          helpText: "B2B lead intelligence, verified email finding, and automated prospect enrichment."
    },
    authorOrRepo: "apollo-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Apollo.io API Key",
    keyUrl: "https://app.apollo.io/#/settings/integrations/api",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.apollo.io/mcp",
      tools: [
        { name: "search_people", description: "Search verified B2B decision makers by title and company", inputSchema: { type: "object" } },
        { name: "enrich_organization", description: "Get funding, tech stack, and employee headcount signals", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-canva",
    slug: "canva-mcp",
    name: "Canva",
    kind: "mcp",
    tabSource: "included",
    category: "Design",
    recommended: true,
    description: "Canva creative design platform MCP server. Inspect, generate, and resize brand banners, posters, and presentation decks.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Canva",
          oauthUrl: "https://www.canva.com/api/oauth",
          keyLabel: "Canva Developer Token / Secret",
          keyUrl: "https://www.canva.com/developers",
          helpText: "Connect with Canva OAuth or provide a developer API key."
    },
    authorOrRepo: "canva-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Canva Developer Connect Token",
    keyUrl: "https://www.canva.com/developers",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.canva.com/mcp",
      tools: [
        { name: "generate_banner", description: "Generate responsive social media and ad banners from brief", inputSchema: { type: "object" } },
        { name: "export_asset", description: "Export high-resolution PNG, SVG, or PDF creative assets", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-google-docs",
    slug: "google-docs-mcp",
    name: "Google Docs",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    recommended: true,
    description: "Google Docs MCP server to create, read, format, and append rich document structures in Google Workspace.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Google Workspace",
          oauthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: [
                "https://www.googleapis.com/auth/documents"
          ],
          helpText: "Authorize Antigravity to create, read, and edit Google Docs directly on your Google account.",
          keyLabel: "Or use Google Service Account JSON / Access Token"
    },
    authorOrRepo: "google-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Google Service Account JSON or API Key",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.google.com/docs/mcp",
      tools: [
        { name: "create_doc", description: "Create a new Google Document with formatted headers and text", inputSchema: { type: "object" } },
        { name: "read_doc", description: "Read full Google Doc content with comments and revisions", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-google-sheets",
    slug: "google-sheets-mcp",
    name: "Google Sheets",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    recommended: true,
    description: "Google Sheets MCP server for spreadsheets, financial models, real-time formula calculations, and tabular row updates.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Google Workspace",
          oauthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: [
                "https://www.googleapis.com/auth/spreadsheets"
          ],
          helpText: "Authorize Antigravity to query, read, and write Google Sheets data and models.",
          keyLabel: "Or use Google Service Account JSON / Access Token"
    },
    authorOrRepo: "google-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Google Service Account JSON or API Key",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.google.com/sheets/mcp",
      tools: [
        { name: "read_sheet_range", description: "Read cell range data as structured tabular JSON", inputSchema: { type: "object" } },
        { name: "append_sheet_row", description: "Append rows with automated formulas to active spreadsheet", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-google-slides",
    slug: "google-slides-mcp",
    name: "Google Slides",
    kind: "mcp",
    tabSource: "included",
    category: "Design",
    recommended: true,
    description: "Google Slides presentation deck builder. Create structured slides, speaker notes, and presentation themes.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Google Workspace",
          oauthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: [
                "https://www.googleapis.com/auth/presentations"
          ],
          helpText: "Authorize Antigravity to create and format Google Slides decks.",
          keyLabel: "Or use Google Service Account JSON / Access Token"
    },
    authorOrRepo: "google-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Google Service Account JSON or API Key",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.google.com/slides/mcp",
      tools: [
        { name: "create_deck", description: "Generate slide deck with custom typography and layouts", inputSchema: { type: "object" } },
        { name: "add_slide", description: "Add new content slide with bullet points and diagrams", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-google-calendar",
    slug: "google-calendar-mcp",
    name: "Google Calendar",
    kind: "mcp",
    tabSource: "included",
    category: "Communication",
    recommended: true,
    description: "Google Calendar scheduling MCP server. Check team availability, schedule meetings, and query upcoming events.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Google Workspace",
          oauthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: [
                "https://www.googleapis.com/auth/calendar"
          ],
          helpText: "Authorize Antigravity to schedule meetings, inspect calendar events, and check free/busy times.",
          keyLabel: "Or use Google Service Account JSON / Access Token"
    },
    authorOrRepo: "google-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Google Service Account JSON or API Key",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.google.com/calendar/mcp",
      tools: [
        { name: "list_events", description: "List calendar events within date and time range", inputSchema: { type: "object" } },
        { name: "create_event", description: "Create meeting event with attendees and Google Meet link", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-gmail",
    slug: "gmail-mcp",
    name: "Gmail",
    kind: "mcp",
    tabSource: "included",
    category: "Communication",
    recommended: true,
    description: "Gmail Workspace MCP server for search, reading threads, composing responses, and inbox triage.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Google Workspace",
          oauthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          scopes: [
                "https://www.googleapis.com/auth/gmail.send",
                "https://www.googleapis.com/auth/gmail.readonly"
          ],
          helpText: "Authorize Antigravity to read incoming email threads and draft responses via Gmail.",
          keyLabel: "Or use Google App Password / OAuth Token"
    },
    authorOrRepo: "google-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Google Service Account JSON or API Key",
    keyUrl: "https://console.cloud.google.com/apis/credentials",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.google.com/gmail/mcp",
      tools: [
        { name: "search_threads", description: "Search Gmail messages using standard query filters", inputSchema: { type: "object" } },
        { name: "send_draft", description: "Draft or send an email to designated recipients", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-outlook",
    slug: "outlook-mcp",
    name: "Outlook",
    kind: "mcp",
    tabSource: "included",
    category: "Communication",
    recommended: false,
    description: "Microsoft 365 Outlook mail and calendar integration for reading enterprise inboxes and planning agendas.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Microsoft 365",
          oauthUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          scopes: [
                "Mail.ReadWrite",
                "Mail.Send"
          ],
          keyLabel: "Microsoft App Password / OAuth Token",
          helpText: "Sign in with your Microsoft 365 or Outlook account."
    },
    authorOrRepo: "microsoft-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Microsoft Graph Access Token / Secret",
    keyUrl: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.microsoft.com/outlook/mcp",
      tools: [
        { name: "get_messages", description: "Read recent Outlook messages from focused inbox", inputSchema: { type: "object" } },
        { name: "create_meeting", description: "Schedule Outlook calendar event with Teams link", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-onedrive",
    slug: "onedrive-mcp",
    name: "OneDrive",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    recommended: false,
    description: "Microsoft OneDrive cloud file storage MCP server for inspecting documents, downloading assets, and syncing files.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Microsoft 365",
          oauthUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          scopes: [
                "Files.ReadWrite"
          ],
          keyLabel: "Microsoft App Password / OAuth Token",
          helpText: "Sign in with your Microsoft account to access OneDrive files."
    },
    authorOrRepo: "microsoft-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Microsoft Graph Access Token / Secret",
    keyUrl: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.microsoft.com/onedrive/mcp",
      tools: [
        { name: "list_files", description: "List OneDrive files and folders", inputSchema: { type: "object" } },
        { name: "download_file", description: "Download file contents from OneDrive cloud", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-email",
    slug: "email-mcp",
    name: "Email",
    kind: "mcp",
    tabSource: "included",
    category: "Communication",
    recommended: true,
    description: "Universal IMAP/SMTP email bridge for reading incoming mail, filtering spam, and dispatching automated notifications.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Email (SMTP / IMAP)",
          helpText: "Connect any custom email account via standard SMTP for sending automated messages.",
          fields: [
                {
                      key: "smtpHost",
                      label: "SMTP Host",
                      type: "text",
                      placeholder: "smtp.mailgun.org or smtp.gmail.com",
                      required: true
                },
                {
                      key: "smtpPort",
                      label: "SMTP Port",
                      type: "text",
                      placeholder: "587",
                      defaultValue: "587",
                      required: true
                },
                {
                      key: "email",
                      label: "Email / Username",
                      type: "text",
                      placeholder: "alerts@yourdomain.com",
                      required: true
                },
                {
                      key: "password",
                      label: "Password / App Password",
                      type: "password",
                      placeholder: "••••••••••••••••",
                      required: true
                }
          ]
    },
    authorOrRepo: "email-standard/mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "Email App Password (imap.host:port:user:pass)",
    keyUrl: "https://myaccount.google.com/apppasswords",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "email-mcp-server"],
      url: "",
      tools: [
        { name: "fetch_inbox", description: "Fetch unread emails from designated IMAP server", inputSchema: { type: "object" } },
        { name: "send_mail", description: "Send outgoing email via SMTP server", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-x",
    slug: "x-mcp",
    name: "X",
    kind: "mcp",
    tabSource: "included",
    category: "Communication",
    recommended: true,
    description: "Official X (Twitter) API MCP server for querying public timelines, tracking sentiment keywords, and posting updates.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "X (Twitter)",
          oauthUrl: "https://twitter.com/i/oauth2/authorize",
          keyLabel: "X API Bearer Token",
          keyPlaceholder: "AAAAAAAAAAAAAAAAAAAAA...",
          keyUrl: "https://developer.x.com/en/portal/dashboard",
          helpText: "Connect with X OAuth or enter your developer Bearer Token."
    },
    authorOrRepo: "x-official",
    verified: true,
    requiresKey: true,
    keyLabel: "X API Bearer Token",
    keyUrl: "https://developer.x.com/en/portal/dashboard",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.x.com/mcp",
      tools: [
        { name: "search_recent_tweets", description: "Search recent tweets matching query keywords", inputSchema: { type: "object" } },
        { name: "post_tweet", description: "Publish new tweet or reply to a thread", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-mobbin",
    slug: "mobbin-mcp",
    name: "Mobbin",
    kind: "mcp",
    tabSource: "included",
    category: "Design",
    recommended: true,
    description: "Mobbin design library MCP server. Inspect 600,000+ real-world mobile and web app screens, design flows, and UI patterns.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Mobbin Session Key",
          keyPlaceholder: "mob_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://mobbin.com",
          helpText: "Access 600,000+ real-world mobile and web UI patterns and interaction flows."
    },
    authorOrRepo: "mobbin-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Mobbin Access Token or Session Token",
    keyUrl: "https://mobbin.com",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.mobbin.com/mcp",
      tools: [
        { name: "search_screens", description: "Search UI screens by app category, flow, and UI pattern", inputSchema: { type: "object" } },
        { name: "get_flow_screens", description: "Get complete onboarding, checkout, or settings user flows", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "plugin-docs-canvas",
    slug: "docs-canvas",
    name: "Docs Canvas",
    kind: "plugin",
    tabSource: "included",
    category: "Design",
    recommended: false,
    description: "Interactive documentation canvas. Live Markdown editing, mermaid diagram preview, and document structuring.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "Interactive document preview and split-screen markdown editor."
    },
    authorOrRepo: "canvas/docs-canvas",
    verified: true,
    pluginConfig: {
      version: "1.2.0",
      hasAgent: true,
      hasDesktop: true,
      tools: [
        { name: "render_canvas", description: "Render dynamic canvas preview of markdown document", inputSchema: { type: "object" } },
      ],
      hooks: [],
      skills: ["docs-canvas"],
      desktop: [{ kind: "webview", label: "Docs Canvas", icon: "FileText", target: "docs-canvas" }],
    },
  },
  {
    id: "plugin-pr-review-canvas",
    slug: "pr-review-canvas",
    name: "PR Review Canvas",
    kind: "plugin",
    tabSource: "included",
    category: "Design",
    recommended: false,
    description: "Visual pull request diff inspector and checklist validator. Compares git branches and flags regression risks.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "GitHub and Bitbucket visual PR review panel with inline code suggestions."
    },
    authorOrRepo: "canvas/pr-review",
    verified: true,
    pluginConfig: {
      version: "1.1.0",
      hasAgent: true,
      hasDesktop: true,
      tools: [
        { name: "inspect_pr_diff", description: "Generate visual change checklist for git pull request", inputSchema: { type: "object" } },
      ],
      hooks: [],
      skills: ["pr-review"],
      desktop: [{ kind: "webview", label: "PR Review", icon: "CheckSquare", target: "pr-review" }],
    },
  },
  {
    id: "mcp-1password",
    slug: "1password-mcp",
    name: "1Password",
    kind: "mcp",
    tabSource: "included",
    category: "Password Managers",
    recommended: true,
    description: "1Password CLI and Connect MCP server. Read secure vault secrets, tokens, and encrypted credentials securely.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "1Password Connect Access Token",
          keyPlaceholder: "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...",
          keyUrl: "https://developer.1password.com/docs/connect",
          helpText: "Secure automated access to company credentials stored in 1Password vaults."
    },
    authorOrRepo: "1password-official",
    verified: true,
    requiresKey: true,
    keyLabel: "1Password Service Account Token",
    keyUrl: "https://developer.1password.com/docs/service-accounts",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@1password/mcp-server"],
      url: "",
      tools: [
        { name: "get_vault_item", description: "Retrieve secret item credentials from 1Password vault", inputSchema: { type: "object" } },
        { name: "list_vault_items", description: "List credentials available in authorized vault", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-atlassian",
    slug: "atlassian-mcp",
    name: "Atlassian",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    recommended: true,
    description: "Atlassian Teamwork Graph MCP server for Jira issue tracker, sprint cycles, and Confluence wiki spaces.",
    requiresAuth: true,
    authConfig: {
          method: "oauth",
          providerName: "Atlassian (Jira & Confluence)",
          oauthUrl: "https://auth.atlassian.com/authorize",
          keyLabel: "Atlassian API Token",
          keyPlaceholder: "ATATT3xFfGF0xxxxxxxxxxxxxxxx",
          keyUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
          helpText: "Sign in with your Atlassian cloud account or generate an API token."
    },
    authorOrRepo: "atlassian-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Atlassian API Token (email:token)",
    keyUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.atlassian.com/mcp",
      tools: [
        { name: "search_jira_issues", description: "Search Jira issues using JQL syntax", inputSchema: { type: "object" } },
        { name: "get_confluence_page", description: "Fetch Confluence documentation page by title or ID", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "plugin-cursor-team-kit",
    slug: "cursor-team-kit",
    name: "Cursor Team Kit",
    kind: "plugin",
    tabSource: "included",
    category: "Productivity",
    recommended: true,
    description: "Cursor IDE team alignment kit. Syncs workspace rules, .cursorrules, and AI guidelines across developer machines.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "Shared agent configurations, prompts, and rule sets for team development."
    },
    authorOrRepo: "cursor/team-kit",
    verified: true,
    pluginConfig: {
      version: "1.0.0",
      hasAgent: true,
      hasDesktop: false,
      tools: [
        { name: "sync_cursorrules", description: "Sync .cursorrules and agent specifications", inputSchema: { type: "object" } },
      ],
      hooks: [],
      skills: ["cursor-team-kit"],
      desktop: [],
    },
  },
  {
    id: "plugin-pstack",
    slug: "pstack-profiler",
    name: "pstack",
    kind: "plugin",
    tabSource: "included",
    category: "Productivity",
    recommended: true,
    description: "Full-stack project stack profiler. Auto-detects runtime environments, installed package managers, and test harnesses.",
    requiresAuth: false,
    authConfig: {
          method: "none",
          helpText: "Performance stack profiler and CPU flamegraph visualizer."
    },
    authorOrRepo: "pstack/profiler",
    verified: true,
    pluginConfig: {
      version: "1.0.4",
      hasAgent: true,
      hasDesktop: false,
      tools: [
        { name: "profile_stack", description: "Detect tech stack, language versions, and test frameworks", inputSchema: { type: "object" } },
      ],
      hooks: [],
      skills: ["pstack"],
      desktop: [],
    },
  },
  {
    id: "mcp-higgsfield",
    slug: "higgsfield-mcp",
    name: "Higgsfield",
    kind: "mcp",
    tabSource: "included",
    category: "Productivity",
    recommended: true,
    description: "Higgsfield AI generative video and dynamic motion animation engine for creating marketing visuals.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Higgsfield AI API Key",
          keyPlaceholder: "hgf_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://higgsfield.ai",
          helpText: "Generative video and dynamic cinematic avatar animation engine."
    },
    authorOrRepo: "higgsfield-ai",
    verified: true,
    requiresKey: true,
    keyLabel: "Higgsfield API Key",
    keyUrl: "https://higgsfield.ai",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.higgsfield.ai/mcp",
      tools: [
        { name: "generate_motion", description: "Generate dynamic motion animation from visual asset", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-finance",
    slug: "finance-mcp",
    name: "Finance",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: true,
    description: "Multi-currency financial ledger and corporate banking synchronization MCP server for automated invoice tracking.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Market Data Provider Key (Polygon / AlphaVantage)",
          keyPlaceholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://polygon.io/dashboard/api-keys",
          helpText: "Real-time stock, forex, and crypto order book data feeds."
    },
    authorOrRepo: "finance-tools/mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "Financial / Banking API Secret",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "finance-mcp"],
      url: "",
      tools: [
        { name: "calculate_balances", description: "Aggregate cashflow balances and ledger entries", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-x-money",
    slug: "x-money-mcp",
    name: "X Money",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: true,
    description: "X Money payment gateway MCP server for merchant payment streams and micropayments.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "X Money Merchant API Key",
          keyPlaceholder: "xm_xxxxxxxxxxxxxxxxxxxxxxxx",
          helpText: "Micro-payment settlement and instant tipping rails over the X platform."
    },
    authorOrRepo: "x-money/mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "X Money Secret Token",
    mcpConfig: {
      transport: "sse",
      url: "https://mcp.x.money/mcp",
      command: "",
      args: [],
      tools: [
        { name: "send_payment", description: "Dispatch payment transfer across supported networks", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-klaviyo",
    slug: "klaviyo-mcp",
    name: "Klaviyo",
    kind: "mcp",
    tabSource: "included",
    category: "Sales & Marketing",
    recommended: false,
    description: "Klaviyo email & SMS customer journey automation, segmentation, and transactional messaging MCP server.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Klaviyo Private API Key (pk_...)",
          keyPlaceholder: "pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://www.klaviyo.com/settings/api-keys",
          helpText: "Customer marketing automation, abandoned cart triggers, and SMS campaigns."
    },
    authorOrRepo: "klaviyo-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Klaviyo Private API Key (pk_...)",
    keyUrl: "https://www.klaviyo.com/settings/account/api-keys",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.klaviyo.com/mcp",
      tools: [
        { name: "track_profile", description: "Update customer profile attributes and segments", inputSchema: { type: "object" } },
        { name: "trigger_flow", description: "Trigger marketing automated email flow", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-brevo",
    slug: "brevo-mcp",
    name: "Brevo",
    kind: "mcp",
    tabSource: "included",
    category: "Sales & Marketing",
    recommended: false,
    description: "Brevo (Sendinblue) email marketing campaigns, transactional SMTP, and contact list management.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Brevo API Key (xkeysib-...)",
          keyPlaceholder: "xkeysib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://app.brevo.com/settings/keys/api",
          helpText: "Transactional emails, WhatsApp marketing, and CRM contact synchronization."
    },
    authorOrRepo: "brevo-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Brevo API Key (xkeysib-...)",
    keyUrl: "https://app.brevo.com/settings/keys/api",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.brevo.com/mcp",
      tools: [
        { name: "send_transactional_email", description: "Send transactional email template with dynamic parameters", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-mailerlite",
    slug: "mailerlite-mcp",
    name: "MailerLite",
    kind: "mcp",
    tabSource: "included",
    category: "Sales & Marketing",
    recommended: false,
    description: "MailerLite newsletter campaign creator, subscriber group segmentation, and click automation stats.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "MailerLite API Token",
          keyPlaceholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://dashboard.mailerlite.com/integrations/api",
          helpText: "Subscriber list segmentation, newsletter campaigns, and automation triggers."
    },
    authorOrRepo: "mailerlite-official",
    verified: true,
    requiresKey: true,
    keyLabel: "MailerLite API Token",
    keyUrl: "https://dashboard.mailerlite.com/integrations/api",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.mailerlite.com/mcp",
      tools: [
        { name: "get_subscribers", description: "Query subscriber list counts and engagement stats", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-bulkpublish",
    slug: "bulkpublish-mcp",
    name: "BulkPublish",
    kind: "mcp",
    tabSource: "included",
    category: "Sales & Marketing",
    recommended: false,
    description: "Content syndication MCP server to cross-publish blogs and release notes to Medium, Dev.to, and Substack.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "BulkPublish License Key",
          keyPlaceholder: "bp_xxxxxxxxxxxxxxxxxxxxxxxx",
          helpText: "Automated multi-platform social media scheduler and batch poster."
    },
    authorOrRepo: "bulkpublish/mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "BulkPublish API Key",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "bulkpublish-mcp"],
      url: "",
      tools: [
        { name: "publish_article", description: "Cross-publish article with canonical URL attributes", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-shopify",
    slug: "shopify-mcp",
    name: "Shopify Merchant",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: true,
    description: "Shopify Merchant store management MCP server. Query inventory, fulfill pending orders, and manage catalog items.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Shopify Merchant",
          keyUrl: "https://help.shopify.com/en/manual/apps/custom-apps",
          helpText: "Enter your Shopify Store domain and Admin API Access Token.",
          fields: [
                {
                      key: "storeUrl",
                      label: "Shopify Store Domain",
                      type: "text",
                      placeholder: "your-store.myshopify.com",
                      required: true
                },
                {
                      key: "accessToken",
                      label: "Admin API Access Token",
                      type: "password",
                      placeholder: "shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                }
          ]
    },
    authorOrRepo: "shopify-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Shopify Admin Access Token",
    keyUrl: "https://help.shopify.com/en/manual/apps/custom-apps",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.shopify.com/mcp",
      tools: [
        { name: "list_orders", description: "Fetch open orders with payment status", inputSchema: { type: "object" } },
        { name: "update_inventory", description: "Adjust inventory quantities for product variants", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-link",
    slug: "link-mcp",
    name: "Link",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: false,
    description: "Stripe Link 1-click checkout and payment rail MCP server for frictionless customer transactions.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Link API Access Key",
          keyPlaceholder: "lnk_xxxxxxxxxxxxxxxxxxxxxxxx",
          helpText: "Deep linking, QR code generation, and attribution tracking engine."
    },
    authorOrRepo: "stripe-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Stripe Link Secret API Key (sk_...)",
    keyUrl: "https://dashboard.stripe.com/apikeys",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.link.com/mcp",
      tools: [
        { name: "create_payment_intent", description: "Create authenticated checkout payment session", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-kraken",
    slug: "kraken-mcp",
    name: "Kraken",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: false,
    description: "Kraken exchange MCP server for real-time crypto order books, spot execution, and portfolio risk telemetry.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Kraken Exchange",
          keyUrl: "https://www.kraken.com/u/security/api",
          helpText: "Connect Kraken API for quant execution, market data, and portfolio rebalancing.",
          fields: [
                {
                      key: "apiKey",
                      label: "API Key",
                      type: "text",
                      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                },
                {
                      key: "privateKey",
                      label: "Private Key / Secret",
                      type: "password",
                      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                }
          ]
    },
    authorOrRepo: "kraken-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Kraken API Key & Private Key",
    keyUrl: "https://pro.kraken.com/app/settings/api",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "kraken-mcp-server"],
      url: "",
      tools: [
        { name: "get_ticker", description: "Get real-time spot price and 24h volume for trading pairs", inputSchema: { type: "object" } },
        { name: "get_order_book", description: "Fetch current L2 order book depth", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-phantom",
    slug: "phantom-mcp",
    name: "Phantom",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: false,
    description: "Phantom Solana wallet MCP server. Check SOL and SPL token balances, verify signatures, and prepare transactions.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Phantom Wallet Session Secret",
          keyPlaceholder: "••••••••••••••••••••••••••••••••",
          helpText: "Solana DeFi integration and dApp transaction signing bridge."
    },
    authorOrRepo: "phantom-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Solana RPC URL or Phantom Key",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "phantom-wallet-mcp"],
      url: "",
      tools: [
        { name: "get_wallet_balance", description: "Get SOL and SPL token balances for wallet address", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-ramp",
    slug: "ramp-mcp",
    name: "Ramp",
    kind: "mcp",
    tabSource: "included",
    category: "Finance",
    recommended: false,
    description: "Ramp corporate cards, automated expense receipts, and vendor spend approval workflow MCP server.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Ramp Developer API Token",
          keyPlaceholder: "rmp_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://ramp.com/developer",
          helpText: "Corporate card issuance, spending limits, and automated receipt matching."
    },
    authorOrRepo: "ramp-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Ramp Developer Client Secret",
    keyUrl: "https://app.ramp.com/developer",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.ramp.com/mcp",
      tools: [
        { name: "list_transactions", description: "List corporate card transactions with accounting categories", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-context-dev",
    slug: "context-dev-mcp",
    name: "Context.dev",
    kind: "mcp",
    tabSource: "included",
    category: "Research",
    recommended: true,
    description: "Context.dev code documentation and architecture context engine for deep multi-repo indexing.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Context.dev API Key",
          keyPlaceholder: "ctx_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://context.dev",
          helpText: "Live developer documentation indexing and code snippet search."
    },
    authorOrRepo: "context-dev/mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "Context.dev Documentation API Key",
    keyUrl: "https://context.dev",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.context.dev/mcp",
      tools: [
        { name: "query_repo_context", description: "Query indexed repository context and design decisions", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-ahrefs",
    slug: "ahrefs-mcp",
    name: "Ahrefs",
    kind: "mcp",
    tabSource: "included",
    category: "Research",
    recommended: false,
    description: "Ahrefs SEO intelligence MCP server. Inspect organic keyword rankings, domain authority, and backlink graphs.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Ahrefs API Key",
          keyPlaceholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://ahrefs.com/api",
          helpText: "SEO backlinks, keyword difficulty, domain rating, and organic competitor analysis."
    },
    authorOrRepo: "ahrefs-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Ahrefs API Key",
    keyUrl: "https://ahrefs.com/api",
    mcpConfig: {
      transport: "sse",
      command: "",
      args: [],
      url: "https://mcp.ahrefs.com/mcp",
      tools: [
        { name: "get_domain_rating", description: "Get Ahrefs Domain Rating and backlink count", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-treg",
    slug: "treg-mcp",
    name: "Treg",
    kind: "mcp",
    tabSource: "included",
    category: "Research",
    recommended: false,
    description: "Treg developer tech radar and open-source software vulnerability and dependency trend analyzer.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Treg Enterprise API Key",
          keyPlaceholder: "trg_xxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://treg.dev",
          helpText: "Compliance rules engine and automated security auditing for enterprise codebases."
    },
    authorOrRepo: "treg/mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "Treg API Key",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "treg-mcp"],
      url: "",
      tools: [
        { name: "analyze_tech_radar", description: "Inspect adoption velocity for libraries and frameworks", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-redis",
    slug: "redis-mcp",
    name: "Redis MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: false,
    description: "Official Redis MCP server for real-time key-value storage, caching, pub/sub messaging, and fast state management.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Redis",
          helpText: "Connect to your local or cloud Redis instance for caching and job queue inspection.",
          fields: [
                {
                      key: "connectionUrl",
                      label: "Redis Connection URL",
                      type: "text",
                      placeholder: "redis://127.0.0.1:6379",
                      defaultValue: "redis://127.0.0.1:6379",
                      required: true
                },
                {
                      key: "password",
                      label: "Auth Password (if required)",
                      type: "password",
                      placeholder: "Optional password",
                      required: false
                }
          ]
    },
    authorOrRepo: "redis-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Redis URL (redis://default:password@host:port)",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-redis"],
      url: "",
      tools: [
        { name: "get_key", description: "Read key value from Redis database", inputSchema: { type: "object" } },
        { name: "set_key", description: "Set key with TTL expiration in Redis", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-mongodb",
    slug: "mongodb-mcp",
    name: "MongoDB MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: false,
    description: "MongoDB database MCP server for document collections, aggregation pipelines, and JSON queries.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "MongoDB",
          helpText: "Connect to MongoDB or MongoDB Atlas for collection queries and document manipulation.",
          fields: [
                {
                      key: "connectionUri",
                      label: "MongoDB Connection URI",
                      type: "password",
                      placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/dbname",
                      required: true
                }
          ]
    },
    authorOrRepo: "mongodb-official",
    verified: true,
    requiresKey: true,
    keyLabel: "MongoDB URI (mongodb+srv://user:pass@cluster.mongodb.net)",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mongodb-mcp-server"],
      url: "",
      tools: [
        { name: "find_documents", description: "Query documents with Mongo filter criteria", inputSchema: { type: "object" } },
        { name: "insert_document", description: "Insert document into designated collection", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-qdrant",
    slug: "qdrant-mcp",
    name: "Qdrant Vector DB",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: false,
    description: "Qdrant vector similarity search engine for high-dimensional semantic search and memory embedding retrieval.",
    requiresAuth: true,
    authConfig: {
          method: "multi_field",
          providerName: "Qdrant Vector DB",
          keyUrl: "https://cloud.qdrant.io",
          helpText: "Connect Qdrant Vector DB for multi-agent semantic search and memory clustering.",
          fields: [
                {
                      key: "clusterUrl",
                      label: "Qdrant Cluster URL",
                      type: "url",
                      placeholder: "https://your-cluster-id.qdrant.tech",
                      required: true
                },
                {
                      key: "apiKey",
                      label: "API Key",
                      type: "password",
                      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                      required: true
                }
          ]
    },
    authorOrRepo: "qdrant-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Qdrant API Key & Host URL",
    keyUrl: "https://cloud.qdrant.io",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-server-qdrant"],
      url: "",
      tools: [
        { name: "search_vectors", description: "Search vector points by cosine similarity", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-pinecone",
    slug: "pinecone-mcp",
    name: "Pinecone MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Data",
    recommended: false,
    description: "Pinecone managed vector database MCP server for dense embeddings, semantic indexing, and knowledge retrieval.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Pinecone API Key (pcsk_...)",
          keyPlaceholder: "pcsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://app.pinecone.io",
          helpText: "High-performance vector database for real-time document search and long-term memory."
    },
    authorOrRepo: "pinecone-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Pinecone API Key",
    keyUrl: "https://app.pinecone.io",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@pinecone-database/mcp"],
      url: "",
      tools: [
        { name: "query_index", description: "Query nearest vector neighbors from Pinecone index", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-exa",
    slug: "exa-mcp",
    name: "Exa Search MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Research",
    recommended: true,
    description: "Exa neural search engine designed for AI models. Finds clean web knowledge by meaning rather than keywords.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Exa Neural Search API Key",
          keyPlaceholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          keyUrl: "https://dashboard.exa.ai/api-keys",
          helpText: "Search the web by meaning using Exa's embedding-based neural search engine."
    },
    authorOrRepo: "exa-labs/exa-mcp",
    verified: true,
    requiresKey: true,
    keyLabel: "Exa API Key",
    keyUrl: "https://dashboard.exa.ai/api-keys",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "exa-mcp-server"],
      url: "",
      tools: [
        { name: "neural_search", description: "Perform semantic search across billions of high quality web pages", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-perplexity",
    slug: "perplexity-mcp",
    name: "Perplexity MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Research",
    recommended: true,
    description: "Perplexity AI search MCP server with live citations, grounding, and real-time facts.",
    requiresAuth: true,
    authConfig: {
          method: "api_key",
          keyLabel: "Perplexity API Key (pplx-...)",
          keyPlaceholder: "pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          keyUrl: "https://www.perplexity.ai/settings/api",
          helpText: "Live web search, citation generation, and deep reasoning via Perplexity Sonar."
    },
    authorOrRepo: "perplexity-official",
    verified: true,
    requiresKey: true,
    keyLabel: "Perplexity API Key (pplx-...)",
    keyUrl: "https://www.perplexity.ai/settings/api",
    mcpConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "perplexity-mcp-server"],
      url: "",
      tools: [
        { name: "ask_perplexity", description: "Query grounded web knowledge with live source citations", inputSchema: { type: "object" } },
      ],
    },
  },
  {
    id: "mcp-docker",
    slug: "docker-mcp",
    name: "Docker MCP",
    kind: "mcp",
    tabSource: "included",
    category: "Code",
    recommended: false,
    description: "Docker daemon MCP server to manage containers, inspect image layers, stream logs, and check volumes.",
    requiresAuth: false,
    authConfig: {
          method: "local_daemon",
          daemonName: "Docker Desktop Daemon",
          daemonCheckCmd: "docker version",
          helpText: "Connects to your local Docker engine via unix:///var/run/docker.sock or npipe:////./pipe/docker_engine without external API keys."
    },
    authorOrRepo: "docker-official",
    verified: true,
    mcpConfig: {
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "mcp/docker"],
      url: "",
      tools: [
        { name: "list_containers", description: "List running and stopped Docker containers", inputSchema: { type: "object" } },
        { name: "inspect_container", description: "Inspect container environment and port mappings", inputSchema: { type: "object" } },
      ],
    },
  },
];

const AUTH_VAULT_KEY = "ronic_mcp_auth_vault";
const LEGACY_AUTH_STORAGE_KEY = "ronic_mcp_authenticated_ids";

const PLACEHOLDER_TEXT = new Set([
  "connected account",
  "active account",
  "api key verified",
  "configured credentials",
  "authenticated",
  "configured",
  "local machine",
  "user@googleworkspace.com",
  "service_account",
  "••••••••",
  "oaut...cmvg",
]);

/** Labels the UI used to write when nobody had signed in. They are not credentials. */
export function isPlaceholderCredential(value?: string): boolean {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return true;
  if (PLACEHOLDER_TEXT.has(text)) return true;
  if (text.endsWith("@googleworkspace.com")) return true;
  if (/^[•*]+$/.test(text)) return true;
  return false;
}

function authRecordProvesConnection(record?: McpAuthRecord): boolean {
  if (!record) return false;
  const method = record.authMethod;
  if (method === "local_daemon" || method === "local_path") {
    return record.verified === true && !isPlaceholderCredential(record.accountIdentity);
  }
  if (method !== "oauth" && method !== "api_key" && method !== "multi_field") return false;
  if (isPlaceholderCredential(record.accountIdentity)) return false;
  if (method === "multi_field") {
    return Object.values(record.config ?? {}).some((value) => !isPlaceholderCredential(value));
  }
  return !isPlaceholderCredential(record.credentialMask);
}

export function getMcpAuthVault(): Record<string, McpAuthRecord> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return {};
    const raw = localStorage.getItem(AUTH_VAULT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, McpAuthRecord>;
    let changed = false;
    for (const key of Object.keys(parsed)) {
      if (!authRecordProvesConnection(parsed[key])) {
        delete parsed[key];
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(AUTH_VAULT_KEY, JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveMcpAuthRecord(record: McpAuthRecord): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (!authRecordProvesConnection(record)) return;
    const vault = getMcpAuthVault();
    vault[record.id] = record;
    localStorage.setItem(AUTH_VAULT_KEY, JSON.stringify(vault));
  } catch {}
}

export function removeMcpAuthRecord(id: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const vault = getMcpAuthVault();
    delete vault[id];
    localStorage.setItem(AUTH_VAULT_KEY, JSON.stringify(vault));
    const legacySet = getAuthenticatedMcpIds();
    legacySet.delete(id);
    localStorage.setItem(LEGACY_AUTH_STORAGE_KEY, JSON.stringify([...legacySet]));
  } catch {}
}

export function getAuthenticatedMcpIds(): Set<string> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return new Set();
    return new Set(Object.keys(getMcpAuthVault()));
  } catch {
    return new Set();
  }
}

/** A local flag is not a provider session. Connect only after a credential check. */
export function markMcpAuthenticated(_id: string): void {}

export function unmarkMcpAuthenticated(id: string): void {
  removeMcpAuthRecord(id);
}

/**
 * Returns true if the catalog item is currently registered in the live snapshot
 */
export function isItemInstalled(item: MarketplaceCatalogItem, snap: Snapshot): boolean {
  if (item.kind === "mcp") {
    return snap.mcpServers.some(
      (s) =>
        s.id === item.id ||
        s.name.toLowerCase() === item.name.toLowerCase() ||
        (item.mcpConfig?.url && s.url && s.url === item.mcpConfig.url)
    );
  }
  if (item.kind === "plugin") {
    return snap.plugins.some(
      (p) =>
        p.id === item.id ||
        p.slug === item.slug ||
        p.name.toLowerCase() === item.name.toLowerCase()
    );
  }
  if (item.kind === "skill") {
    return snap.skills.some(
      (s) =>
        s.slug === item.slug ||
        s.title.toLowerCase() === item.name.toLowerCase()
    );
  }
  return false;
}

/**
 * Checks if an item is fully installed and authenticated according to its required auth method.
 * If an item requires OAuth, an API key, or multi-field credentials, it is NEVER considered
 * connected unless an authenticated auth record is present in the vault.
 */
export function isItemConnected(
  item: MarketplaceCatalogItem,
  snap: Snapshot,
  authenticatedIds?: Set<string>,
  authVault?: Record<string, McpAuthRecord>
): boolean {
  const installed = isItemInstalled(item, snap);
  if (!installed) return false;

  void authenticatedIds;
  const method = item.authConfig?.method;
  if (method === "none" || (!method && item.requiresAuth !== true && item.requiresKey !== true)) {
    return true;
  }

  const vault = authVault || getMcpAuthVault();
  return authRecordProvesConnection(vault[item.id]);
}

export type MarketplaceItemStatus = "connected" | "needs_auth" | "not_installed";

export function getItemStatus(
  item: MarketplaceCatalogItem,
  snap: Snapshot,
  authenticatedIds?: Set<string>,
  authVault?: Record<string, McpAuthRecord>
): MarketplaceItemStatus {
  const installed = isItemInstalled(item, snap);
  if (!installed) return "not_installed";

  const connected = isItemConnected(item, snap, authenticatedIds, authVault);
  if (connected) return "connected";

  return "needs_auth";
}

/**
 * Install a catalog item into SQLite, local filesystem, and active bot profile
 */
export async function installMarketplaceItem(
  item: MarketplaceCatalogItem,
  profileId: string,
  run: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
  authPayload?: {
    secretKey?: string;
    identity?: string;
    config?: Record<string, string>;
    advanced?: AdvancedAuthConfig;
    verified?: boolean;
  } | string
): Promise<string> {
  const targetProfile = profileId || "";
  const secretKey = typeof authPayload === "string" ? authPayload : authPayload?.secretKey || "";
  const identity = typeof authPayload === "object" ? authPayload.identity : "";
  const config = typeof authPayload === "object" ? authPayload.config : undefined;
  const advanced = typeof authPayload === "object" ? authPayload.advanced : undefined;

  if (item.kind === "mcp") {
    const draft = {
      id: item.id,
      name: item.name,
      transport: item.mcpConfig?.transport || "stdio",
      command: item.mcpConfig?.command || "",
      args: item.mcpConfig?.args || [],
      url: advanced?.endpointUrl || item.mcpConfig?.url || "",
      tools: item.mcpConfig?.tools || [],
      secret: secretKey || (config ? JSON.stringify({ ...config, ...(advanced || {}) }) : advanced ? JSON.stringify(advanced) : ""),
    };
    const saved = await run("save_mcp", { draft });
    if (saved == null) throw new Error(`${item.name} was not saved, so it was not marked connected.`);
    const trusted = await run("trust_mcp", { id: item.id });
    if (trusted == null) throw new Error(`${item.name} was not trusted, so it was not marked connected.`);
    if (targetProfile) {
      await run("toggle_mcp", { id: item.id, profileId: targetProfile, enabled: true });
    }

    const authMethod = item.authConfig?.method || (item.requiresAuth || item.requiresKey ? "api_key" : "none");
    const needsProof = authMethod === "oauth" || authMethod === "api_key" || authMethod === "multi_field" || authMethod === "local_daemon" || authMethod === "local_path";
    if (needsProof) {
      const verified = typeof authPayload === "object" && authPayload?.verified === true;
      const identityText = (identity || "").trim();
      const secretText = secretKey.trim();
      const configValues = config ? Object.values(config).map((value) => value.trim()).filter(Boolean) : [];
      const secretReal = secretText.length > 0 && !isPlaceholderCredential(secretText);
      const configReal = configValues.some((value) => !isPlaceholderCredential(value));
      const identityReal = !isPlaceholderCredential(identityText);
      const local = authMethod === "local_daemon" || authMethod === "local_path";
      if (!verified || !identityReal || (!local && !secretReal && !configReal)) {
        throw new Error(`${item.name} was not connected. The credential check has to succeed first.`);
      }
      const mask = secretReal
        ? secretText.length > 8
          ? `${secretText.slice(0, 4)}...${secretText.slice(-4)}`
          : `key${secretText.length}`
        : "fields-checked";
      saveMcpAuthRecord({
        id: item.id,
        authMethod,
        authenticatedAt: Date.now(),
        accountIdentity: identityText,
        credentialMask: mask,
        config,
        advanced,
        verified: true,
      });
    }

    const remote = Boolean(item.mcpConfig?.url);
    return remote
      ? `Checked and saved "${item.name}". The credential stays in the vault.`
      : `Installed "${item.name}" on this computer.`;
  }

  if (item.kind === "plugin") {
    const draft = {
      id: item.id,
      slug: item.slug,
      name: item.name,
      version: item.pluginConfig?.version || "1.0.0",
      hasAgent: item.pluginConfig?.hasAgent ?? true,
      hasDesktop: item.pluginConfig?.hasDesktop ?? false,
      tools: item.pluginConfig?.tools || [],
      hooks: item.pluginConfig?.hooks || [],
      skills: item.pluginConfig?.skills || [],
      desktop: item.pluginConfig?.desktop || [],
    };
    await run("save_plugin", { draft });
    await run("trust_plugin", { id: item.id });
    if (targetProfile) {
      await run("toggle_plugin_agent", { id: item.id, profileId: targetProfile, enabled: true });
    }
    return `✓ Plugin "${item.name}" saved with tools & skills, trusted, and mounted.`;
  }

  if (item.kind === "skill") {
    const body =
      item.skillConfig?.body ||
      `---\nname: ${item.slug}\ndescription: ${item.description}\nslash_command: /${item.slug}\nrequires_tools: []\nplatforms: [windows, macos, linux]\n---\n\n# ${item.name}\n\n${item.description}\n`;

    const draft = {
      profileId: targetProfile,
      slug: item.slug,
      title: item.skillConfig?.title || item.name,
      description: item.skillConfig?.description || item.description,
      slashCommand: item.skillConfig?.slashCommand || `/${item.slug}`,
      requiresTools: item.skillConfig?.requiresTools || [],
      platforms: item.skillConfig?.platforms || ["windows", "macos", "linux"],
      body,
    };
    await run("save_skill", { draft });
    if (targetProfile) {
      const skillId = `sk-${targetProfile}-${item.slug}`;
      await run("toggle_skill", { id: skillId, profileId: targetProfile, enabled: true });
    }
    const verified = typeof authPayload === "object" && authPayload?.verified === true;
    if (verified && secretKey && identity && !isPlaceholderCredential(identity) && !isPlaceholderCredential(secretKey)) {
      saveMcpAuthRecord({
        id: item.id,
        authMethod: "api_key",
        authenticatedAt: Date.now(),
        accountIdentity: identity,
        credentialMask: secretKey.length > 8 ? `${secretKey.slice(0, 4)}...${secretKey.slice(-4)}` : `key${secretKey.length}`,
        verified: true,
      });
    }
    return `✓ Skill "${item.name}" saved to SKILL.md and enabled for profile.`;
  }

  return "Installed item.";
}

/**
 * Remove a catalog item from SQLite, filesystem, and active profile
 */
export async function removeMarketplaceItem(
  item: MarketplaceCatalogItem,
  snap: Snapshot,
  run: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
): Promise<string> {
  if (item.kind === "mcp") {
    const existing = snap.mcpServers.find(
      (s) =>
        s.id === item.id ||
        s.name.toLowerCase() === item.name.toLowerCase() ||
        (item.mcpConfig?.url && s.url && s.url === item.mcpConfig.url)
    );
    const idToRemove = existing?.id || item.id;
    await run("remove_mcp", { id: idToRemove });
    removeMcpAuthRecord(item.id);
    return `✓ Removed MCP server "${item.name}".`;
  }

  if (item.kind === "plugin") {
    const existing = snap.plugins.find(
      (p) =>
        p.id === item.id ||
        p.slug === item.slug ||
        p.name.toLowerCase() === item.name.toLowerCase()
    );
    const idToRemove = existing?.id || item.id;
    await run("remove_plugin", { id: idToRemove });
    removeMcpAuthRecord(item.id);
    return `✓ Removed Plugin "${item.name}".`;
  }

  if (item.kind === "skill") {
    const existing = snap.skills.find(
      (s) =>
        s.slug === item.slug ||
        s.title.toLowerCase() === item.name.toLowerCase()
    );
    if (existing) {
      await run("remove_skill", { id: existing.id });
    }
    removeMcpAuthRecord(item.id);
    return `✓ Removed Skill "${item.name}".`;
  }

  return "Removed item.";
}
