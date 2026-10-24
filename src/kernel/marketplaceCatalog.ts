import type { Snapshot } from "../types";

export interface MarketplaceCatalogItem {
  id: string;
  slug: string;
  name: string;
  kind: "mcp" | "plugin" | "skill";
  tabSource: "included" | "store";
  category: "Productivity" | "Code & Reverse Engineering" | "Supercharge & Bots" | "Quant & FinTech";
  description: string;
  authorOrRepo: string;
  verified: boolean;
  requiresKey?: boolean;
  keyLabel?: string;
  keyUrl?: string;
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
      "Notion's remote MCP server. Adding it records the server and prompts OAuth sign-in when your bot connects to query databases or create pages.",
    authorOrRepo: "notion-official",
    verified: true,
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
      "Linear's remote MCP server for issues, cycles, and roadmaps. Connects via OAuth when a bot queries Linear tickets or assigns bug remediation.",
    authorOrRepo: "linear-official",
    verified: true,
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
      "Sentry's remote MCP server for production stacktraces, issues, and release health. Used by Scout bots to detect crashes and regressions.",
    authorOrRepo: "sentry-official",
    verified: true,
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
      "Supabase MCP server for Postgres schema inspection, migrations, and edge functions. Enables bots to design schemas and query tables.",
    authorOrRepo: "supabase-official",
    verified: true,
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
];

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
 * Install a catalog item into SQLite, local filesystem, and active bot profile
 */
export async function installMarketplaceItem(
  item: MarketplaceCatalogItem,
  profileId: string,
  run: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
  secretKey?: string
): Promise<string> {
  const targetProfile = profileId || "";

  if (item.kind === "mcp") {
    const draft = {
      id: item.id,
      name: item.name,
      transport: item.mcpConfig?.transport || "stdio",
      command: item.mcpConfig?.command || "",
      args: item.mcpConfig?.args || [],
      url: item.mcpConfig?.url || "",
      tools: item.mcpConfig?.tools || [],
      secret: secretKey || "",
    };
    await run("save_mcp", { draft });
    await run("trust_mcp", { id: item.id });
    if (targetProfile) {
      await run("toggle_mcp", { id: item.id, profileId: targetProfile, enabled: true });
    }
    const remote = Boolean(item.mcpConfig?.url);
    return remote
      ? `Saved "${item.name}" on this computer. Chat does not call that remote server yet.`
      : `Saved "${item.name}" on this computer. A bot starts it with the recorded command.`;
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
    return `✓ Removed Skill "${item.name}".`;
  }

  return "Removed item.";
}

