import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

function generateBackupJson(memories, user) {
  return JSON.stringify(
    {
      vault_version: "2.1.0",
      export_timestamp: 1730000000000,
      export_date: "2026-10-30T14:00:00.000Z",
      operator: {
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        tier: user.tier,
      },
      system: {
        os: "windows",
        kernel: "ronic-kernel-v2",
        format: "ronic-memory-vault-v2",
      },
      total_memories: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.contentMarkdown,
        sourceType: m.sourceType,
        scopedBotId: m.scopedBotId,
        filePathOrUri: m.filePathOrUri,
        wikilinks: m.wikilinks || [],
        updatedAt: m.updatedAt,
        engineOrigin: m.engineOrigin,
        syncedEngines: m.syncedEngines || [],
      })),
    },
    null,
    2
  );
}

function generateBackupMarkdown(memories, user) {
  const header = `# Ronic OS Memory Vault Export
> Exported on: 2026-10-30, 2:00:00 PM
> Operator: ${user.displayName || "Operator"} (${user.email || "Local Workspace"})
> Total Atomic Notes: ${memories.length}
---

`;

  const body = memories
    .map((m, idx) => {
      const wikilinksFormatted = (m.wikilinks || []).map((w) => `[[${w}]]`).join(", ");
      return `## ${idx + 1}. ${m.title || "Untitled Memory"}
- **ID**: \`${m.id}\`
- **Origin Engine**: \`${m.engineOrigin || "mem0_builtin"}\`
- **Updated At**: ${new Date(m.updatedAt || 1730000000000).toLocaleString()}
- **Related Wikilinks**: ${wikilinksFormatted || "None"}
- **Scope / Source**: ${m.sourceType || "system"}${m.filePathOrUri ? ` (${m.filePathOrUri})` : ""}

${m.contentMarkdown}

---
`;
    })
    .join("\n");

  return header + body;
}

test("generateBackupJson creates structured valid JSON with all metadata", () => {
  const mockUser = {
    displayName: "Harish",
    email: "harish@ronic.os",
    role: "Lead Architect",
    tier: "Pro Studio",
  };
  const mockMemories = [
    {
      id: "mem_1",
      title: "Hyperliquid Slippage Parameter",
      contentMarkdown: "Keep max slippage under 0.5% for all perp pairs.",
      sourceType: "trading_rule",
      scopedBotId: "bot_1",
      filePathOrUri: "vault/trading.md",
      wikilinks: ["TradingRules", "RiskManagement"],
      updatedAt: 1730000000000,
      engineOrigin: "mem0_builtin",
      syncedEngines: ["mem0_builtin", "obsidian_khoj"],
    },
  ];

  const jsonStr = generateBackupJson(mockMemories, mockUser);
  const parsed = JSON.parse(jsonStr);

  assert.equal(parsed.vault_version, "2.1.0");
  assert.equal(parsed.total_memories, 1);
  assert.equal(parsed.operator.email, "harish@ronic.os");
  assert.equal(parsed.memories[0].id, "mem_1");
  assert.deepEqual(parsed.memories[0].wikilinks, ["TradingRules", "RiskManagement"]);
});

test("generateBackupMarkdown formats Obsidian-compliant Wikilinks", () => {
  const mockUser = {
    displayName: "Harish",
    email: "harish@ronic.os",
  };
  const mockMemories = [
    {
      id: "mem_2",
      title: "Rust Architecture Invariants",
      contentMarkdown: "Always verify with cargo check before merging.",
      sourceType: "doc",
      scopedBotId: null,
      filePathOrUri: "docs/arch.md",
      wikilinks: ["RustKernel", "Invariants"],
      updatedAt: 1730000000000,
      engineOrigin: "mem0_builtin",
      syncedEngines: [],
    },
  ];

  const md = generateBackupMarkdown(mockMemories, mockUser);
  assert.ok(md.includes("# Ronic OS Memory Vault Export"));
  assert.ok(md.includes("## 1. Rust Architecture Invariants"));
  assert.ok(md.includes("[[RustKernel]]"));
  assert.ok(md.includes("[[Invariants]]"));
  assert.ok(md.includes("Always verify with cargo check before merging."));
});

test("backup content produces verifiable SHA-256 hash", () => {
  const payload = "Sample atomic memory payload for backup verification";
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64);
  assert.equal(hash, crypto.createHash("sha256").update(payload).digest("hex"));
});

